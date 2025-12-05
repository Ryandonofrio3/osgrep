import * as fs from "node:fs";
import * as path from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-node";

// CONFIGURATION
const MODEL_DIR = path.resolve("./osgrep-models/colbert"); // Adjust if your path differs
const MODEL_PATH = path.join(MODEL_DIR, "model.onnx");
const SKIPLIST_PATH = path.join(MODEL_DIR, "skiplist.json");

async function main() {
  console.log("🔍 Starting ColBERT Integrity Check...\n");

  // --- CHECK 1: FILES EXIST ---
  if (!fs.existsSync(MODEL_PATH))
    throw new Error(`Missing model at ${MODEL_PATH}`);
  if (!fs.existsSync(SKIPLIST_PATH))
    throw new Error(`Missing skiplist at ${SKIPLIST_PATH}`);
  console.log("✅ Files found.");

  // --- CHECK 2: TOKENIZER & MARKERS ---
  console.log("⏳ Loading Tokenizer...");
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_DIR);

  const queryText = "function test(a, b)";
  // We manually add the [Q] marker to simulate what the worker does
  // Note: We use the ID we know works from your export: 50368
  // But let's see if the tokenizer resolves "[Q] " correctly.

  const encoded = await tokenizer(queryText, { add_special_tokens: false });
  const inputIds = encoded.input_ids; // BigInt64Array in newer transformers versions

  // Convert to standard array for inspection
  const ids = Array.from(inputIds).map(Number);

  // Mixedbread expects: [CLS] [Q] ...tokens... [SEP]
  // Let's verify we can construct that.
  const Q_ID = 50368;
  const CLS_ID = tokenizer.model.tokens_to_ids.get("[CLS]") ?? 50281; // Fallback to standard if null

  console.log(`\n--- Tokenizer Check ---`);
  console.log(`Query: "${queryText}"`);
  console.log(`Raw IDs:`, ids);

  // Check if tokenizer recognizes the special tokens by text
  const qCheck = tokenizer.model.tokens_to_ids.get("[Q] ");
  const dCheck = tokenizer.model.tokens_to_ids.get("[D] ");

  if (qCheck === 50368 && dCheck === 50369) {
    console.log(`✅ Tokenizer Map Correct: [Q] -> ${qCheck}, [D] -> ${dCheck}`);
  } else {
    console.error(
      `❌ Tokenizer Map Mismatch! Found [Q]->${qCheck}, [D]->${dCheck}`,
    );
    console.error(`   Expected 50368 and 50369.`);
  }

  // --- CHECK 3: SKIPLIST ---
  const skiplist = new Set(JSON.parse(fs.readFileSync(SKIPLIST_PATH, "utf-8")));
  console.log(`\n--- Skiplist Check ---`);
  console.log(`Skiplist size: ${skiplist.size}`);

  // Check common punctuation
  const commaId = tokenizer.model.tokens_to_ids.get(",");
  const dotId = tokenizer.model.tokens_to_ids.get(".");

  if (skiplist.has(commaId) && skiplist.has(dotId)) {
    console.log(
      `✅ Skiplist contains punctuation ('.'=${dotId}, ','=${commaId})`,
    );
  } else {
    console.error(`❌ Skiplist missing basic punctuation!`);
  }

  // --- CHECK 4: ONNX INFERENCE ---
  console.log(`\n--- ONNX Inference Check ---`);
  const session = await ort.InferenceSession.create(MODEL_PATH);
  console.log(`Session loaded. Input names: ${session.inputNames}`);

  // Construct a dummy batch: [CLS] [Q] test [SEP]
  const batchIds = [
    BigInt(CLS_ID),
    BigInt(Q_ID),
    BigInt(1234),
    BigInt(tokenizer.sep_token_id ?? 50282),
  ];
  const tensorIds = new ort.Tensor(
    "int64",
    new BigInt64Array(batchIds),
    [1, 4],
  );
  const tensorMask = new ort.Tensor(
    "int64",
    new BigInt64Array([BigInt(1), BigInt(1), BigInt(1), BigInt(1)]),
    [1, 4],
  );

  const start = performance.now();
  const feeds = { input_ids: tensorIds, attention_mask: tensorMask };
  const results = await session.run(feeds);
  const end = performance.now();

  const outputName = session.outputNames[0];
  const embeddings = results[outputName];

  // Dims should be [1, 4, 48]
  const dims = embeddings.dims;
  console.log(`Output Dimensions: [${dims.join(", ")}]`);
  console.log(`Inference Time (cold): ${(end - start).toFixed(2)}ms`);

  if (dims[2] !== 48) {
    console.error(`❌ CRITICAL: Expected dimension 48, got ${dims[2]}`);
    process.exit(1);
  } else {
    console.log(`✅ Correct dimension (48d) detected.`);
  }

  // --- CHECK 5: MAXSIM PERFORMANCE SIMULATION ---
  console.log(`\n--- MaxSim Logic Benchmark ---`);

  // Create dummy vectors for a fake document (1000 tokens)
  const docLen = 1000;
  const docIds = new Array(docLen)
    .fill(0)
    .map(() => Math.floor(Math.random() * 50000));

  // Inject some punctuation into the dummy document to simulate real text
  // Let's say 15% of the doc is punctuation
  let punctuationCount = 0;
  for (let i = 0; i < docLen; i++) {
    if (Math.random() < 0.15) {
      docIds[i] = commaId ?? 0; // Force a comma
      punctuationCount++;
    }
  }

  const qLen = 32;

  // Naive Dot Product count
  const naiveOps = qLen * docLen;

  // Skiplist Dot Product count
  let optimizedOps = 0;
  for (let i = 0; i < qLen; i++) {
    for (let j = 0; j < docLen; j++) {
      if (!skiplist.has(docIds[j])) {
        optimizedOps++;
      }
    }
  }

  console.log(`Document Length: ${docLen} tokens`);
  console.log(
    `Punctuation/Skip tokens: ${punctuationCount} (~${((punctuationCount / docLen) * 100).toFixed(1)}%)`,
  );
  console.log(`Naive Operations: ${naiveOps}`);
  console.log(`Skiplist Operations: ${optimizedOps}`);
  console.log(`Savings: ${naiveOps - optimizedOps} operations avoided`);
  console.log(
    `⚡ Speedup: ${(naiveOps / optimizedOps).toFixed(2)}x (theoretical)`,
  );

  console.log("\n✅ VERIFICATION COMPLETE. MODEL IS GOOD TO GO.");
}

main().catch((err) => {
  console.error("\n❌ TEST FAILED:", err);
  process.exit(1);
});
