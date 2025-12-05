import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "../../config";
import { getLanguageByExtension } from "../core/languages";
import { GRAMMARS_DIR } from "./grammar-loader";

// web-tree-sitter ships a CommonJS build
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser;
const Language = TreeSitter.Language;

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  type:
    | "function"
    | "method"
    | "class"
    | "interface"
    | "type_alias"
    | "block"
    | "other";
  context?: string[];
}

export type ChunkWithContext = Chunk & {
  context: string[];
  chunkIndex?: number;
  isAnchor?: boolean;
};

export interface FileMetadata {
  imports: string[];
  exports: string[];
  comments: string[];
}

export interface ChunkingResult {
  chunks: Chunk[];
  metadata: FileMetadata;
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

export function formatChunkText(
  chunk: ChunkWithContext,
  filePath: string,
): { content: string; displayText: string } {
  const breadcrumb = [...chunk.context];
  const fileLabel = `File: ${filePath || "unknown"}`;
  const hasFileLabel = breadcrumb.some(
    (entry) => typeof entry === "string" && entry.startsWith("File: "),
  );
  if (!hasFileLabel) {
    breadcrumb.unshift(fileLabel);
  }
  const header = breadcrumb.length > 0 ? breadcrumb.join(" > ") : fileLabel;
  const displayText = `${header}\n---\n${chunk.content}`;

  // Minimal prefix for embedding: just the file path comment
  const content = `// ${filePath}\n${chunk.content}`;

  return { content, displayText };
}

export function buildAnchorChunk(
  filePath: string,
  content: string,
  metadata: FileMetadata,
): Chunk & { context: string[]; chunkIndex: number; isAnchor: boolean } {
  const lines = content.split("\n");

  const preamble: string[] = [];
  let nonBlank = 0;
  let totalChars = 0;
  let lastIncludedLineIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    preamble.push(line);
    lastIncludedLineIdx = i;
    nonBlank += 1;
    totalChars += line.length;
    if (nonBlank >= 30 || totalChars >= 1200) break;
  }

  const sections: string[] = [];
  sections.push(`File: ${filePath}`);
  if (metadata.imports.length > 0) {
    sections.push(`Imports: ${metadata.imports.join(", ")}`);
  }
  if (metadata.exports.length > 0) {
    sections.push(`Exports: ${metadata.exports.join(", ")}`);
  }
  if (metadata.comments.length > 0) {
    sections.push(`Top comments:\n${metadata.comments.join("\n")}`);
  }
  if (preamble.length > 0) {
    sections.push(`Preamble:\n${preamble.join("\n")}`);
  }
  sections.push("---");
  sections.push("(anchor)");

  const anchorText = sections.join("\n\n");
  const approxEndLine = Math.min(
    lines.length - 1,
    Math.max(0, lastIncludedLineIdx),
  );

  return {
    content: anchorText,
    startLine: 0,
    endLine: approxEndLine,
    type: "block",
    context: [`File: ${filePath}`, "Anchor"],
    chunkIndex: -1,
    isAnchor: true,
  };
}

export class TreeSitterChunker {
  private parser: TreeSitterParser | null = null;
  private languages: Map<string, TreeSitterLanguage | null> = new Map();
  private initialized = false;

  // Tuned for speed: Fill the context window (512 tokens) more aggressively.
  private readonly MAX_CHUNK_LINES = CONFIG.MAX_CHUNK_LINES;
  private readonly MAX_CHUNK_CHARS = CONFIG.MAX_CHUNK_CHARS;
  private readonly OVERLAP_LINES = 10;
  private readonly OVERLAP_CHARS = 200;

  async init() {
    if (this.initialized) return;
    try {
      await Parser.init({
        locator: require.resolve("web-tree-sitter/tree-sitter.wasm"),
      });
      this.parser = new Parser() as TreeSitterParser;
    } catch (_err) {
      console.warn(
        "⚠️  Offline mode: Semantic search quality reduced (Tree-Sitter unavailable)",
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
      console.warn(
        `⚠️  Missing grammar for ${lang}. Run 'osgrep setup' to download it. Using fallback chunking.`,
      );
      return null;
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

  async chunk(filePath: string, content: string): Promise<ChunkingResult> {
    if (!this.initialized) await this.init();

    let result: ChunkingResult = {
      chunks: [],
      metadata: { imports: [], exports: [], comments: [] },
    };

    if (this.parser) {
      try {
        result = await this.chunkWithTreeSitter(filePath, content);
      } catch {
        result.chunks = [];
      }
    }

    if (result.chunks.length === 0) {
      result.chunks = this.fallbackChunk(content, filePath);
    }

    // Split chunks if too big
    result.chunks = result.chunks.flatMap((c) => this.splitIfTooBig(c));
    return result;
  }

  private async chunkWithTreeSitter(
    filePath: string,
    content: string,
  ): Promise<ChunkingResult> {
    const ext = path.extname(filePath);
    const langDef = getLanguageByExtension(ext);
    const lang = langDef?.grammar?.name || "";
    if (!lang)
      return {
        chunks: [],
        metadata: { imports: [], exports: [], comments: [] },
      };

    const language = await this.getLanguage(lang);
    if (!language || !this.parser)
      return {
        chunks: [],
        metadata: { imports: [], exports: [], comments: [] },
      };

    this.parser.setLanguage(language);
    const tree = this.parser.parse(content);
    const root = tree.rootNode;

    const fileContext = `File: ${filePath}`;
    const chunks: Chunk[] = [];
    const blockChunks: Chunk[] = [];
    let cursorIndex = 0;
    let cursorRow = 0;
    let sawDefinition = false;

    const metadata: FileMetadata = { imports: [], exports: [], comments: [] };
    const definitionTypes = langDef?.definitionTypes || [];

    const isDefType = (t: string) => definitionTypes.includes(t);

    const classify = (node: TreeSitterNode): Chunk["type"] => {
      const t = node.type;
      if (t.includes("method")) return "method";
      if (t.includes("class")) return "class";
      if (t.includes("interface")) return "interface";
      if (t.includes("type_alias")) return "type_alias";
      if (isDefType(t) || isTopLevelValueDef(node)) return "function";
      return "block";
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
      if (/(?:^|\n)\s*(?:export\s+)?const\s+[A-Z0-9_]+\s*=/.test(text))
        return true;
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
      if (t.includes("interface"))
        return `Interface: ${name ?? "<anonymous interface>"}`;
      if (t.includes("type_alias"))
        return `Type: ${name ?? "<anonymous type>"}`;
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
      // Metadata extraction
      if (
        node.type === "import_statement" ||
        node.type === "import_declaration"
      ) {
        metadata.imports.push(node.text.trim());
      } else if (
        node.type === "export_statement" ||
        node.type === "export_declaration"
      ) {
        // Simple export extraction
        metadata.exports.push(node.text.trim().split("\n")[0]);
      } else if (node.type.includes("comment")) {
        if (node.startPosition.row < 10) {
          // Only top comments
          metadata.comments.push(node.text.trim());
        }
      }

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

    if (!sawDefinition) return { chunks: [], metadata };

    const combined = [...blockChunks, ...chunks].sort(
      (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
    );
    return { chunks: combined, metadata };
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

    if (charCount > this.MAX_CHUNK_CHARS && lineCount <= this.MAX_CHUNK_LINES) {
      return this.splitByChars(chunk);
    }

    const subChunks: Chunk[] = [];
    const stride = Math.max(1, this.MAX_CHUNK_LINES - this.OVERLAP_LINES);

    // Simplified splitting logic
    for (let i = 0; i < lines.length; i += stride) {
      const end = Math.min(i + this.MAX_CHUNK_LINES, lines.length);
      const subLines = lines.slice(i, end);
      if (subLines.length < 3 && i > 0) continue;

      subChunks.push({
        content: subLines.join("\n"),
        startLine: chunk.startLine + i,
        endLine: chunk.startLine + end,
        type: chunk.type,
        context: chunk.context,
      });
    }

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
