import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const GRAMMARS_DIR = path.join(os.homedir(), ".osgrep", "grammars");

const GRAMMAR_URLS: Record<string, string> = {
  typescript:
    "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm",
  tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
  python:
    "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.25.0/tree-sitter-python.wasm",
  go: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
  rust: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.23.2/tree-sitter-rust.wasm",
  cpp: "https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm",
  c: "https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.23.4/tree-sitter-c.wasm",
  java: "https://github.com/tree-sitter/tree-sitter-java/releases/download/v0.23.4/tree-sitter-java.wasm",
  c_sharp:
    "https://github.com/tree-sitter/tree-sitter-c-sharp/releases/download/v0.23.1/tree-sitter-c_sharp.wasm",
  ruby: "https://github.com/tree-sitter/tree-sitter-ruby/releases/download/v0.23.1/tree-sitter-ruby.wasm",
  php: "https://github.com/tree-sitter/tree-sitter-php/releases/download/v0.23.11/tree-sitter-php.wasm",
  json: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
  yaml: "https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/download/v0.7.0/tree-sitter-yaml.wasm",
  kotlin:
    "https://github.com/fwcd/tree-sitter-kotlin/releases/download/0.3.8/tree-sitter-kotlin.wasm",
  swift:
    "https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.1-pypi/tree-sitter-swift.wasm",
  dart: "https://cdn.jsdelivr.net/npm/tree-sitter-dart@1.0.0/tree-sitter-dart.wasm",
};

/** List of supported grammar names (for filtering files by grammar support) */
export const SUPPORTED_GRAMMARS = Object.keys(GRAMMAR_URLS);

const downloadFile = async (url: string, dest: string) => {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "osgrep",
    },
  });
  if (!response.ok) throw new Error(`Failed to download ${url}`);
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
};

export async function ensureGrammars(log: (msg: string) => void = console.log) {
  if (!fs.existsSync(GRAMMARS_DIR)) {
    fs.mkdirSync(GRAMMARS_DIR, { recursive: true });
  }

  for (const [lang, url] of Object.entries(GRAMMAR_URLS)) {
    const dest = path.join(GRAMMARS_DIR, `tree-sitter-${lang}.wasm`);
    if (fs.existsSync(dest)) {
      log(`✓ Grammar: ${lang}`);
    } else {
      // Use process.stdout directly for the "Downloading..." part if possible,
      // but to keep it simple with the passed log function, we'll just log a start message.
      // If the caller passed console.log, it will print a newline.
      // For a better UX, we might want to allow a more complex logger, but for now:
      if (log === console.log) {
        process.stdout.write(`⬇ Downloading ${lang} grammar... `);
      } else {
        log(`⬇ Downloading ${lang} grammar...`);
      }

      try {
        await downloadFile(url, dest);
        if (log === console.log) {
          console.log("Done");
        } else {
          log(`Downloaded ${lang} grammar`);
        }
      } catch (err) {
        if (log === console.log) {
          console.log("Failed");
        }
        console.error(`  Error downloading ${lang}:`, err);
      }
    }
  }
}
