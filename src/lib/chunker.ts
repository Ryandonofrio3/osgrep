import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// web-tree-sitter ships a CommonJS build
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser;
const Language = TreeSitter.Language;

const GRAMMARS_DIR = path.join(os.homedir(), ".osgrep", "grammars");

const GRAMMAR_URLS: Record<string, string> = {
  typescript:
    "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-typescript.wasm",
  tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-tsx.wasm",
  python:
    "https://github.com/tree-sitter/tree-sitter-python/releases/latest/download/tree-sitter-python.wasm",
};

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  type: "function" | "class" | "block" | "other";
  context?: string[];
}

// Minimal TreeSitter node interface
interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  namedChildren?: TreeSitterNode[];
  parent?: TreeSitterNode;
  childForFieldName?: (field: string) => TreeSitterNode | null;
}

// TreeSitter Parser and Language types
interface TreeSitterParser {
  init(options: { locator: string }): Promise<void>;
  setLanguage(language: TreeSitterLanguage): void;
  parse(content: string): { rootNode: TreeSitterNode };
}

type TreeSitterLanguage = Record<string, never>;

export class TreeSitterChunker {
  private parser: TreeSitterParser | null = null;
  private languages: Map<string, TreeSitterLanguage | null> = new Map();
  private initialized = false;

  // Tuned for speed: Fill the context window (512 tokens) more aggressively.
  private readonly MAX_CHUNK_LINES = 75;
  private readonly MAX_CHUNK_CHARS = 2000;
  private readonly OVERLAP_LINES = 10;

  // For long single-line or low-newline regions (json, lockfiles, huge strings)
  private readonly OVERLAP_CHARS = 200;

  async init() {
    if (this.initialized) return;
    try {
      await Parser.init({
        locator: require.resolve("web-tree-sitter/tree-sitter.wasm"),
      });
      this.parser = new Parser() as TreeSitterParser;
    } catch (err) {
      console.error(
        "Falling back to paragraph chunking; tree-sitter init failed:",
        err,
      );
      this.parser = null;
    }

    if (!fs.existsSync(GRAMMARS_DIR)) {
      fs.mkdirSync(GRAMMARS_DIR, { recursive: true });
    }
    this.initialized = true;
  }

  private async getLanguage(lang: string): Promise<TreeSitterLanguage | null> {
    const cached = this.languages.get(lang);
    if (cached !== undefined) return cached;

    const wasmPath = path.join(GRAMMARS_DIR, `tree-sitter-${lang}.wasm`);
    if (!fs.existsSync(wasmPath)) {
      const url = GRAMMAR_URLS[lang];
      if (!url) return null;
      try {
        await this.downloadFile(url, wasmPath);
      } catch {
        return null;
      }
    }

    try {
      const language = Language
        ? ((await Language.load(wasmPath)) as TreeSitterLanguage | null)
        : null;
      this.languages.set(lang, language);
      return language;
    } catch {
      return null;
    }
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}`);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(dest, Buffer.from(arrayBuffer));
  }

  async chunk(filePath: string, content: string): Promise<Chunk[]> {
    if (!this.initialized) await this.init();

    let rawChunks: Chunk[] = [];

    if (this.parser) {
      try {
        rawChunks = await this.chunkWithTreeSitter(filePath, content);
      } catch {
        rawChunks = [];
      }
    }

    if (rawChunks.length === 0) {
      rawChunks = this.fallbackChunk(content, filePath);
    }

    return rawChunks.flatMap((c) => this.splitIfTooBig(c));
  }

  private async chunkWithTreeSitter(
    filePath: string,
    content: string,
  ): Promise<Chunk[]> {
    const ext = path.extname(filePath).toLowerCase();
    let lang = "";
    if (ext === ".ts") lang = "typescript";
    else if (ext === ".tsx") lang = "tsx";
    else if (ext === ".py") lang = "python";
    else if (ext === ".js" || ext === ".jsx") lang = "tsx";
    if (!lang) return [];

    const language = await this.getLanguage(lang);
    if (!language || !this.parser) return [];

    this.parser.setLanguage(language);
    const tree = this.parser.parse(content);
    const root = tree.rootNode;

    const fileContext = `File: ${filePath}`;
    const chunks: Chunk[] = [];
    const blockChunks: Chunk[] = [];
    let cursorIndex = 0;
    let cursorRow = 0;
    let sawDefinition = false;

    const isDefType = (t: string) =>
      [
        "function_declaration",
        "function_definition",
        "method_definition",
        "class_declaration",
        "class_definition",
      ].includes(t);

    const classify = (node: TreeSitterNode): "function" | "class" | "other" => {
      const t = node.type;
      if (t.includes("class")) return "class";
      if (isDefType(t)) return "function";
      return "other";
    };

    const unwrapExport = (node: TreeSitterNode): TreeSitterNode => {
      if (
        node.type === "export_statement" &&
        node.namedChildren &&
        node.namedChildren.length > 0
      ) {
        return node.namedChildren[0];
      }
      return node;
    };

    // Treat lexical/variable declarations with function-like bodies as defs
    const isTopLevelValueDef = (node: TreeSitterNode): boolean => {
      const t = node.type;
      if (t !== "lexical_declaration" && t !== "variable_declaration")
        return false;
      const parentType = node.parent?.type || "";
      const allowedParents = ["program", "module", "source_file", "class_body"];
      if (parentType && !allowedParents.includes(parentType)) return false;
      const text = node.text || "";
      if (text.includes("=>")) return true;
      if (text.includes("function ")) return true;
      if (text.includes("class ")) return true;
      return false;
    };

    const getNodeName = (node: TreeSitterNode): string | null => {
      const byField = (field: string) => {
        const child =
          typeof node.childForFieldName === "function"
            ? node.childForFieldName(field)
            : null;
        if (child?.text) return String(child.text);
        return null;
      };

      const fieldNames = ["name", "property", "identifier"];
      for (const field of fieldNames) {
        const name = byField(field);
        if (name) return name;
      }

      const identifierChild = (node.namedChildren ?? []).find((c) =>
        [
          "identifier",
          "property_identifier",
          "type_identifier",
          "field_identifier",
        ].includes(c.type),
      );
      if (identifierChild?.text) return String(identifierChild.text);

      for (const child of node.namedChildren ?? []) {
        if (child.type === "variable_declarator") {
          const idChild = (child.namedChildren ?? []).find((c) =>
            ["identifier", "property_identifier", "type_identifier"].includes(
              c.type,
            ),
          );
          if (idChild?.text) return String(idChild.text);
        }
      }

      const match = (node.text || "").match(
        /(?:class|function)\s+([A-Za-z0-9_$]+)/,
      );
      if (match?.[1]) return match[1];

      const varMatch = (node.text || "").match(
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)/,
      );
      if (varMatch?.[1]) return varMatch[1];

      return null;
    };

    const labelForNode = (node: TreeSitterNode): string | null => {
      const name = getNodeName(node);
      const t = node.type;
      if (t.includes("class")) return `Class: ${name ?? "<anonymous class>"}`;
      if (t.includes("method"))
        return `Method: ${name ?? "<anonymous method>"}`;
      if (t.includes("function"))
        return `Function: ${name ?? "<anonymous function>"}`;
      if (isTopLevelValueDef(node))
        return `Function: ${name ?? "<anonymous function>"}`;
      return name ? `Symbol: ${name}` : null;
    };

    const addChunk = (node: TreeSitterNode, context: string[]) => {
      chunks.push({
        content: node.text,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        type: classify(node),
        context,
      });
    };

    const visit = (node: TreeSitterNode, stack: string[]) => {
      const effective = unwrapExport(node);
      const isDefinition =
        isDefType(effective.type) || isTopLevelValueDef(effective);
      let nextStack = stack;

      if (isDefinition) {
        sawDefinition = true;
        const label = labelForNode(effective);
        const context = [...stack, ...(label ? [label] : [])];
        addChunk(effective, context);
        nextStack = context;
      }

      for (const child of effective.namedChildren ?? []) {
        visit(child, nextStack);
      }
    };

    for (const child of root.namedChildren ?? []) {
      visit(child, [fileContext]);

      const effective = unwrapExport(child);
      const isDefinition =
        isDefType(effective.type) || isTopLevelValueDef(effective);
      if (!isDefinition) continue;

      if (child.startIndex > cursorIndex) {
        const gapText = content.slice(cursorIndex, child.startIndex);
        if (gapText.trim().length > 0) {
          blockChunks.push({
            content: gapText,
            startLine: cursorRow,
            endLine: child.startPosition.row,
            type: "block",
            context: [fileContext],
          });
        }
      }

      cursorIndex = child.endIndex;
      cursorRow = child.endPosition.row;
    }

    if (cursorIndex < content.length) {
      const tailText = content.slice(cursorIndex);
      if (tailText.trim().length > 0) {
        blockChunks.push({
          content: tailText,
          startLine: cursorRow,
          endLine: root.endPosition.row,
          type: "block",
          context: [fileContext],
        });
      }
    }

    if (!sawDefinition) return [];

    const combined = [...blockChunks, ...chunks].sort(
      (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
    );
    return combined;
  }

  private splitIfTooBig(chunk: Chunk): Chunk[] {
    const charCount = chunk.content.length;
    const lines = chunk.content.split("\n");
    const lineCount = lines.length;

    if (
      lineCount <= this.MAX_CHUNK_LINES &&
      charCount <= this.MAX_CHUNK_CHARS
    ) {
      return [chunk];
    }

    // If huge but low-newline, split by chars
    if (charCount > this.MAX_CHUNK_CHARS && lineCount <= this.MAX_CHUNK_LINES) {
      return this.splitByChars(chunk);
    }

    // Line-based sliding window split
    const subChunks: Chunk[] = [];
    const stride = Math.max(1, this.MAX_CHUNK_LINES - this.OVERLAP_LINES);

    const header = this.extractHeaderLine(chunk.content);

    for (let i = 0; i < lines.length; i += stride) {
      const end = Math.min(i + this.MAX_CHUNK_LINES, lines.length);
      const subLines = lines.slice(i, end);
      if (subLines.length < 3 && i > 0) continue;

      let subContent = subLines.join("\n");
      if (header && i > 0 && chunk.type !== "block") {
        subContent = `${header}\n${subContent}`;
      }

      subChunks.push({
        content: subContent,
        startLine: chunk.startLine + i,
        endLine: chunk.startLine + end,
        type: chunk.type,
        context: chunk.context,
      });
    }

    // Safety: char split any leftover giant subchunks
    return subChunks.flatMap((sc) =>
      sc.content.length > this.MAX_CHUNK_CHARS ? this.splitByChars(sc) : [sc],
    );
  }

  private splitByChars(chunk: Chunk): Chunk[] {
    const res: Chunk[] = [];
    const stride = Math.max(1, this.MAX_CHUNK_CHARS - this.OVERLAP_CHARS);

    for (let i = 0; i < chunk.content.length; i += stride) {
      const end = Math.min(i + this.MAX_CHUNK_CHARS, chunk.content.length);
      const sub = chunk.content.slice(i, end);
      if (sub.trim().length === 0) continue;

      const prefixLines = chunk.content.slice(0, i).split("\n").length - 1;
      const subLineCount = sub.split("\n").length;

      res.push({
        content: sub,
        startLine: chunk.startLine + prefixLines,
        endLine: chunk.startLine + prefixLines + subLineCount,
        type: chunk.type,
        context: chunk.context,
      });
    }

    return res;
  }

  private extractHeaderLine(text: string): string | null {
    const lines = text.split("\n");
    for (const l of lines) {
      const t = l.trim();
      if (t.length === 0) continue;
      return t;
    }
    return null;
  }

  private fallbackChunk(content: string, filePath: string): Chunk[] {
    const lines = content.split("\n");
    const chunks: Chunk[] = [];
    const stride = Math.max(1, this.MAX_CHUNK_LINES - this.OVERLAP_LINES);
    const context = [`File: ${filePath}`];

    for (let i = 0; i < lines.length; i += stride) {
      const end = Math.min(i + this.MAX_CHUNK_LINES, lines.length);
      const subLines = lines.slice(i, end);
      if (subLines.length === 0) continue;

      const subContent = subLines.join("\n");
      chunks.push({
        content: subContent,
        startLine: i,
        endLine: end,
        type: "block",
        context,
      });
    }

    return chunks;
  }
}
