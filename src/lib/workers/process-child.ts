import process from "node:process";
import processFile, {
  encodeQuery,
  type ProcessFileInput,
  type ProcessFileResult,
  type RerankDoc,
  rerank,
} from "./worker";

type IncomingMessage =
  | { id: number; method: "processFile"; payload: ProcessFileInput }
  | { id: number; method: "encodeQuery"; payload: { text: string } }
  | {
    id: number;
    method: "rerank";
    payload: { query: number[][]; docs: RerankDoc[]; colbertDim: number };
  };

type OutgoingMessage =
  | { id: number; result: ProcessFileResult }
  | { id: number; result: Awaited<ReturnType<typeof encodeQuery>> }
  | { id: number; result: Awaited<ReturnType<typeof rerank>> }
  | { id: number; error: string }
  | { id: number; heartbeat: true };

const send = (msg: OutgoingMessage) => {
  if (process.send) {
    process.send(msg);
  }
};

process.on("message", async (msg: IncomingMessage) => {
  const { id, method, payload } = msg;
  try {
    if (method === "processFile") {
      const onProgress = () => {
        send({ id, heartbeat: true });
      };
      const result = await processFile(payload, onProgress);
      send({ id, result });
      return;
    }
    if (method === "encodeQuery") {
      const result = await encodeQuery(payload);
      send({ id, result });
      return;
    }
    if (method === "rerank") {
      const result = await rerank(payload);
      send({ id, result });
      return;
    }
    send({ id, error: `Unknown method: ${method}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ id, error: message });
  }
});

process.on("uncaughtException", (err) => {
  console.error("[process-worker] uncaughtException", err);
  process.exitCode = 1;
  process.exit();
});

process.on("unhandledRejection", (reason) => {
  console.error("[process-worker] unhandledRejection", reason);
  process.exitCode = 1;
  process.exit();
});
