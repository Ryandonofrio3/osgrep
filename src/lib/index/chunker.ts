import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "../../config";
import { getLanguageByExtension } from "../core/languages";
import { GRAMMARS_DIR } from "./grammar-loader";

// web-tree-sitter ships a CommonJS build
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser;
const Language = TreeSitter.Language;

function resolveTreeSitterWasmLocator(): string {
  try {
    return require.resolve("web-tree-sitter/tree-sitter.wasm");
  } catch {
    try {
      const pkgDir = path.dirname(
        require.resolve("web-tree-sitter/package.json"),
      );
      const candidate = path.join(pkgDir, "tree-sitter.wasm");
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // fall through to final fallback
    }

    return path.join(
      __dirname,
      "..",
      "..",
      "..",
      "node_modules",
      "web-tree-sitter",
      "tree-sitter.wasm",
    );
  }
}

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
  docstring?: string;
  complexity?: number;
  isExported?: boolean;
  definedSymbols?: string[];
  referencedSymbols?: string[];
  role?: string;
  parentSymbol?: string;
}

export type ChunkWithContext = Chunk & {
  context: string[];
  chunkIndex?: number;
  isAnchor?: boolean;
  imports?: string[];
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

function isDocLikeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".md", ".mdx", ".txt", ".rst", ".adoc"].includes(ext);
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
  previousSibling?: TreeSitterNode | null;
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

  const sections: string[] = [];

  // 1. File path (always first)
  sections.push(`// ${filePath}`);

  // 2. Imports (if available)
  if (chunk.imports && chunk.imports.length > 0) {
    sections.push(
      chunk.imports
        .map((imp) => (imp.startsWith("import") ? imp : `import ${imp}`))
        .join("\n"),
    );
  }

  // 3. Breadcrumb
  const header = breadcrumb.length > 0 ? breadcrumb.join(" > ") : fileLabel;
  sections.push(header);

  // 4. Code content
  sections.push(chunk.content);

  // 5. Docstring (if available)
  if (chunk.docstring) {
    sections.push(chunk.docstring);
  }

  const displayText = sections.join("\n");

  // Embed the rich, contextual text so rerank can see breadcrumbs/imports/etc.
  const content = displayText;

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
      const wasmLocator = resolveTreeSitterWasmLocator();
      await Parser.init({
        locator: wasmLocator,
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
      this.languages.set(lang, null);
      return null;
    }

    try {
      const language = Language
        ? ((await Language.load(wasmPath)) as TreeSitterLanguage | null)
        : null;
      this.languages.set(lang, language);
      return language;
    } catch {
      this.languages.set(lang, null);
      return null;
    }
  }

  async chunk(filePath: string, content: string): Promise<ChunkingResult> {
    if (!this.initialized) await this.init();

    const docLike = isDocLikeFile(filePath);
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
      // FIX: Skip fallback chunking for large data files to prevent memory leaks/CPU spikes
      // on massive generated JSON/YAML/XML files.
      const isDataFile = [".json", ".yaml", ".yml", ".xml", ".csv", ".map"].includes(
        path.extname(filePath).toLowerCase(),
      );
      // 100KB limit for data files that don't have tree-sitter support or failed to parse
      const LARGE_DATA_FILE_LIMIT = 100 * 1024;

      if (isDataFile && content.length > LARGE_DATA_FILE_LIMIT) {
        // Return empty result for large data files
      } else {
        result.chunks = this.fallbackChunk(content, filePath);
      }
    }

    if (docLike) {
      result.chunks = result.chunks.map((c) => ({ ...c, role: "DOCS" }));
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
    if (ext === ".json") {
      return {
        chunks: [],
        metadata: { imports: [], exports: [], comments: [] },
      };
    }

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
      // Classify strictly by the node's own type; avoid language-wide keyword inference
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

    const getDocstring = (node: TreeSitterNode): string | undefined => {
      const comments: string[] = [];
      let current = node.previousSibling;
      while (current) {
        const t = current.type;
        if (t.includes("comment")) {
          comments.unshift(current.text);
          current = current.previousSibling;
        } else if (current.text.trim().length === 0) {
          // whitespace
          current = current.previousSibling;
        } else {
          break;
        }
      }
      return comments.length > 0 ? comments.join("\n") : undefined;
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
        // Extract exported identifier
        const effective = unwrapExport(node);
        const name = getNodeName(effective);
        if (name) {
          metadata.exports.push(name);
        }
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

        const docstring = getDocstring(node);

        // Calculate complexity
        const getComplexity = (n: TreeSitterNode): number => {
          let complexity = 1;
          const complexTypes = [
            "if_statement",
            "for_statement",
            "while_statement",
            "switch_statement",
            "catch_clause",
            "conditional_expression",
            "binary_expression", // simplistic, but counts logical ops usually
          ];

          const countComplexity = (curr: TreeSitterNode) => {
            if (complexTypes.includes(curr.type)) {
              if (curr.type === "binary_expression") {
                const op = curr.childForFieldName
                  ? curr.childForFieldName("operator")
                  : null;
                if (["&&", "||", "??"].includes(op?.text || "")) {
                  complexity++;
                }
              } else {
                complexity++;
              }
            }
            for (const child of curr.namedChildren ?? []) {
              countComplexity(child);
            }
          };
          countComplexity(n);
          return complexity;
        };

        const complexity = getComplexity(effective);

        // Check if exported
        const name = getNodeName(effective);
        const isExported = name ? metadata.exports.includes(name) : false;

        // Extract symbols
        const definedSymbols: string[] = [];
        if (name) definedSymbols.push(name);

        const referencedSymbols: string[] = [];
        const extractRefs = (n: TreeSitterNode) => {
          // Handle JS/TS (call_expression) and Python (call)
          if (n.type === "call_expression" || n.type === "call") {
            const func = n.childForFieldName
              ? n.childForFieldName("function")
              : null;
            if (func) {
              let funcName = func.text;

              // Handle member access (obj.method) to extract just 'method'
              if (func.type === "member_expression") {
                // JS/TS: object.property
                const prop = func.childForFieldName
                  ? func.childForFieldName("property")
                  : null;
                if (prop) funcName = prop.text;
              } else if (func.type === "attribute") {
                // Python: object.attribute
                const attr = func.childForFieldName
                  ? func.childForFieldName("attribute")
                  : null;
                if (attr) funcName = attr.text;
              }

              referencedSymbols.push(funcName);
            }
          }
          for (const child of n.namedChildren ?? []) {
            extractRefs(child);
          }
        };
        extractRefs(effective);

        // Classify role
        let role = "IMPLEMENTATION";
        if (isDefinition) role = "DEFINITION";
        if (complexity > 5 && referencedSymbols.length > 5)
          role = "ORCHESTRATION";
        if (effective.type.includes("import")) role = "IMPORT";

        chunks.push({
          content: node.text,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          type: classify(effective),
          context,
          docstring,
          complexity,
          isExported,
          definedSymbols,
          referencedSymbols,
          role,
          parentSymbol:
            stack.length > 1
              ? stack[stack.length - 1].replace(
                /^(Class|Method|Function|Interface|Type): /,
                "",
              )
              : undefined,
        });
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
        ...chunk,
        content: subLines.join("\n"),
        startLine: chunk.startLine + i,
        endLine: chunk.startLine + end - 1,
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
        ...chunk,
        content: sub,
        startLine: chunk.startLine + prefixLines,
        endLine: chunk.startLine + prefixLines + subLineCount - 1,
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
        endLine: i + subLines.length - 1,
        type: "block",
        context,
      });
    }

    return chunks;
  }
}
