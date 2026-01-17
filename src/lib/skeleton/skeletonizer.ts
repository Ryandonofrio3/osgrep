/**
 * Skeletonizer - Compress code by replacing function bodies with summaries.
 *
 * Reduces token usage by 80-95% while preserving:
 * - Function/method signatures
 * - Class/interface declarations (structure preserved, methods skeletonized)
 * - Type definitions
 * - Decorators and annotations
 * - Inline summaries of what functions do (calls, complexity, role)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getLanguageByExtension } from "../core/languages";
import { GRAMMARS_DIR } from "../index/grammar-loader";
import { getBodyField } from "./body-fields";
import {
  type ChunkMetadata,
  formatSkeletonHeader,
  formatSummary,
  getCommentStyle,
} from "./summary-formatter";

// Import web-tree-sitter (CommonJS)
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser;
const Language = TreeSitter.Language;

// TreeSitter types (matching chunker.ts)
interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  namedChildren?: TreeSitterNode[];
  children?: TreeSitterNode[];
  parent?: TreeSitterNode;
  childForFieldName?: (field: string) => TreeSitterNode | null;
  previousSibling?: TreeSitterNode | null;
}

interface TreeSitterParser {
  setLanguage(language: TreeSitterLanguage): void;
  parse(content: string): { rootNode: TreeSitterNode };
}

type TreeSitterLanguage = Record<string, never>;

// Result types
export interface SkeletonResult {
  success: boolean;
  skeleton: string;
  tokenEstimate: number;
  symbolCount: number;
  language: string;
  error?: string;
}

export interface SkeletonOptions {
  /** Preserve decorators/annotations in output. Default: true */
  preserveDecorators?: boolean;
  /** Include summary comment in elided bodies. Default: true */
  includeSummary?: boolean;
  /** Max function calls to show in summary. Default: 4 */
  maxCallsInSummary?: number;
}

/** Represents a region to elide (replace with summary) */
interface ElisionRegion {
  bodyStart: number;
  bodyEnd: number;
  summary: string;
  langId: string;
}

const DEFAULT_OPTIONS: Required<SkeletonOptions> = {
  preserveDecorators: true,
  includeSummary: true,
  maxCallsInSummary: 4,
};

// WASM locator (same as chunker.ts)
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
      // fall through
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

/**
 * Main Skeletonizer class.
 */
export class Skeletonizer {
  private parser: TreeSitterParser | null = null;
  private languages: Map<string, TreeSitterLanguage | null> = new Map();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const wasmLocator = resolveTreeSitterWasmLocator();
      await Parser.init({ locator: wasmLocator });
      this.parser = new Parser() as TreeSitterParser;
    } catch (_err) {
      console.warn("⚠️  TreeSitter unavailable for skeletonization");
      this.parser = null;
    }

    if (!fs.existsSync(GRAMMARS_DIR)) {
      fs.mkdirSync(GRAMMARS_DIR, { recursive: true });
    }

    this.initialized = true;
  }

  /**
   * Check if a file can be skeletonized.
   */
  isSupported(filePath: string): {
    supported: boolean;
    language?: string;
    reason?: string;
  } {
    const ext = path.extname(filePath).toLowerCase();
    const langDef = getLanguageByExtension(ext);

    if (!langDef) {
      return {
        supported: false,
        reason: `Unknown file extension: ${ext}`,
      };
    }

    if (!langDef.grammar) {
      return {
        supported: false,
        language: langDef.id,
        reason: `No TreeSitter grammar for ${langDef.id}`,
      };
    }

    return {
      supported: true,
      language: langDef.id,
    };
  }

  /**
   * Skeletonize a file.
   */
  async skeletonizeFile(
    filePath: string,
    content: string,
    options?: SkeletonOptions,
  ): Promise<SkeletonResult> {
    if (!this.initialized) await this.init();

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const support = this.isSupported(filePath);

    // Handle unsupported languages
    if (!support.supported) {
      return this.createFallbackResult(
        filePath,
        content,
        support.reason || "Unsupported language",
      );
    }

    const ext = path.extname(filePath).toLowerCase();
    const langDef = getLanguageByExtension(ext);
    if (!langDef?.grammar) {
      return this.createFallbackResult(
        filePath,
        content,
        "No grammar available",
      );
    }

    // Load language
    const language = await this.getLanguage(langDef.grammar.name);
    if (!language || !this.parser) {
      return this.createFallbackResult(
        filePath,
        content,
        "Failed to load grammar",
      );
    }

    try {
      // Parse the file
      this.parser.setLanguage(language);
      const tree = this.parser.parse(content);
      const root = tree.rootNode;

      // Find all regions to elide (function/method bodies)
      const elisions: ElisionRegion[] = [];
      this.findElisionRegions(root, langDef.id, content, elisions, opts);

      if (elisions.length === 0) {
        // No functions found - return a compact version
        return this.createFallbackResult(
          filePath,
          content,
          "No functions/methods found",
        );
      }

      // Sort by position (ascending) for correct reconstruction
      elisions.sort((a, b) => a.bodyStart - b.bodyStart);

      // Build skeleton by replacing bodies with summaries
      const skeleton = this.buildSkeleton(content, elisions, langDef.id);
      const tokenEstimate = Math.ceil(skeleton.length / 4);

      return {
        success: true,
        skeleton: `${formatSkeletonHeader(filePath, tokenEstimate, langDef.id)}\n${skeleton}`,
        tokenEstimate,
        symbolCount: elisions.length,
        language: langDef.id,
      };
    } catch (err) {
      return this.createFallbackResult(
        filePath,
        content,
        `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Find all regions that should be elided (function/method bodies).
   * Recurses into containers (classes) to find methods.
   */
  private findElisionRegions(
    node: TreeSitterNode,
    langId: string,
    content: string,
    elisions: ElisionRegion[],
    opts: Required<SkeletonOptions>,
  ): void {
    // Check if this node has a body to elide
    const bodyFieldName = getBodyField(langId, node.type);

    if (typeof bodyFieldName === "string") {
      // This is a function/method - extract its body region
      const bodyNode = node.childForFieldName?.(bodyFieldName);
      if (bodyNode) {
        const summary = this.createSummary(bodyNode, langId, opts);
        elisions.push({
          bodyStart: bodyNode.startIndex,
          bodyEnd: bodyNode.endIndex,
          summary,
          langId,
        });
        // Don't recurse into the body - we're eliding it
        return;
      }
    }

    // For containers (classes) or other nodes, recurse into children
    const children = node.namedChildren || [];
    for (const child of children) {
      this.findElisionRegions(child, langId, content, elisions, opts);
    }
  }

  /**
   * Create a summary comment for a function body.
   */
  private createSummary(
    bodyNode: TreeSitterNode,
    langId: string,
    opts: Required<SkeletonOptions>,
  ): string {
    if (!opts.includeSummary) {
      return this.createElidedBody(langId, "// ...");
    }

    // Extract metadata from the body
    const referencedSymbols = this.extractReferencedSymbols(bodyNode, langId);
    const complexity = this.calculateComplexity(bodyNode);
    const role = this.classifyRole(complexity, referencedSymbols.length);

    const metadata: ChunkMetadata = {
      referencedSymbols,
      complexity,
      role,
    };

    const commentStyle = getCommentStyle(langId);
    const summaryLine = formatSummary(metadata, {
      maxCalls: opts.maxCallsInSummary,
      commentStyle,
    });

    return this.createElidedBody(langId, summaryLine);
  }

  /**
   * Create an elided body with summary for a specific language.
   */
  private createElidedBody(langId: string, summary: string): string {
    switch (langId) {
      case "python":
        // Python uses indented ... (Ellipsis) - valid syntax
        return `\n    ${summary}\n    ...`;
      case "ruby":
        // Ruby body doesn't include closing 'end' in AST - it's preserved after
        return `\n    ${summary}`;
      default:
        // C-style languages use { ... }
        return `{\n    ${summary}\n  }`;
    }
  }

  /**
   * Build the skeleton by replacing function bodies with summaries.
   */
  private buildSkeleton(
    content: string,
    elisions: ElisionRegion[],
    _langId: string,
  ): string {
    const parts: string[] = [];
    let cursor = 0;

    for (const elision of elisions) {
      // Add content before this body
      if (elision.bodyStart > cursor) {
        parts.push(content.slice(cursor, elision.bodyStart));
      }

      // Add the elided body with summary
      parts.push(elision.summary);

      cursor = elision.bodyEnd;
    }

    // Add remaining content after last elision
    if (cursor < content.length) {
      parts.push(content.slice(cursor));
    }

    return this.cleanupSkeleton(parts.join(""));
  }

  /**
   * Clean up the skeleton output.
   */
  private cleanupSkeleton(skeleton: string): string {
    return (
      skeleton
        // Remove excessive blank lines
        .replace(/\n{3,}/g, "\n\n")
        // Trim trailing whitespace on lines
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim()
    );
  }

  /**
   * Create a fallback result when skeletonization isn't possible.
   * Returns first 30 lines as preview.
   */
  private createFallbackResult(
    filePath: string,
    content: string,
    reason: string,
  ): SkeletonResult {
    const lines = content.split("\n");
    const previewLines = lines.slice(0, 30);
    const truncated = lines.length > 30;

    const preview = [
      `// Skeleton unavailable: ${reason}`,
      `// File: ${filePath}`,
      `// Showing first ${Math.min(30, lines.length)} lines${truncated ? " (truncated)" : ""}`,
      "",
      ...previewLines,
      ...(truncated ? ["", `// ... ${lines.length - 30} more lines`] : []),
    ].join("\n");

    return {
      success: false,
      skeleton: preview,
      tokenEstimate: Math.ceil(preview.length / 4),
      symbolCount: 0,
      language: reason.includes("Unknown file extension")
        ? path.extname(filePath)
        : "unknown",
      error: reason,
    };
  }

  /**
   * Load a TreeSitter language grammar.
   */
  private async getLanguage(lang: string): Promise<TreeSitterLanguage | null> {
    const cached = this.languages.get(lang);
    if (cached !== undefined) return cached;

    const wasmPath = path.join(GRAMMARS_DIR, `tree-sitter-${lang}.wasm`);
    if (!fs.existsSync(wasmPath)) {
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

  /**
   * Extract referenced symbols (function calls) from a node.
   */
  private extractReferencedSymbols(
    node: TreeSitterNode,
    langId: string,
  ): string[] {
    const refs: string[] = [];
    const seen = new Set<string>();

    const getNavigationIdentifier = (node: TreeSitterNode): string | null => {
      if (node.type !== "navigation_expression") return null;
      const suffixes = (node.namedChildren || []).filter(
        (child) => child.type === "navigation_suffix",
      );
      const lastSuffix = suffixes[suffixes.length - 1];
      if (lastSuffix) {
        const simple = (lastSuffix.namedChildren || []).find(
          (child) => child.type === "simple_identifier",
        );
        if (simple?.text) return simple.text;
      }
      // Fallback: look at nested navigation expressions or identifiers
      const fallbacks = [...(node.namedChildren || [])].reverse();
      for (const child of fallbacks) {
        if (child.type === "simple_identifier" && child.text) {
          return child.text;
        }
        if (child.type === "navigation_expression") {
          const nested = getNavigationIdentifier(child);
          if (nested) return nested;
        }
      }
      return null;
    };

    const getCallFunctionNode = (
      node: TreeSitterNode,
    ): TreeSitterNode | null => {
      const direct =
        node.childForFieldName?.("function") ||
        node.childForFieldName?.("name") ||
        null;
      if (direct) return direct;
      return node.namedChildren && node.namedChildren.length > 0
        ? node.namedChildren[0]
        : null;
    };

    const extractFunctionName = (
      func: TreeSitterNode | null,
    ): string | null => {
      if (!func) return null;
      if (func.type === "member_expression") {
        const prop = func.childForFieldName?.("property");
        if (prop?.text) return prop.text;
      } else if (func.type === "attribute") {
        const attr = func.childForFieldName?.("attribute");
        if (attr?.text) return attr.text;
      } else if (func.type === "navigation_expression") {
        const navName = getNavigationIdentifier(func);
        if (navName) return navName;
      }

      // Fallback: use direct text (strip qualifiers like Module.)
      const raw = func.text || "";
      if (raw.includes(".")) {
        const lastSegment = raw.split(".").pop();
        if (lastSegment) return lastSegment;
      }
      return raw || null;
    };

    const extractSwiftArgumentLabels = (
      callNode: TreeSitterNode,
    ): string[] => {
      const suffix =
        callNode.childForFieldName?.("call_suffix") ||
        (callNode.namedChildren || []).find(
          (child) => child.type === "call_suffix",
        );
      if (!suffix) return [];

      const labels: string[] = [];
      const collect = (current: TreeSitterNode) => {
        if (current.type === "value_argument") {
          const labelNode =
            current.childForFieldName?.("label") ||
            (current.namedChildren || []).find(
              (child) => child.type === "value_argument_label",
            );

          if (labelNode) {
            const simple = (labelNode.namedChildren || []).find(
              (child) => child.type === "simple_identifier",
            );
            labels.push(simple?.text || labelNode.text.replace(/[:\s]/g, ""));
          } else {
            labels.push("_");
          }
        } else {
          for (const child of current.namedChildren || []) {
            collect(child);
          }
        }
      };

      collect(suffix);
      return labels;
    };

    const formatSwiftFunction = (
      baseName: string,
      callNode: TreeSitterNode,
    ): string => {
      const labels = extractSwiftArgumentLabels(callNode);
      const meaningful = labels.filter((label) => label && label !== "_");
      if (labels.length === 0 || meaningful.length === 0) return baseName;

      const truncated = labels.slice(0, 3).map((label) => `${label || "_"}:`);
      if (labels.length > 3) truncated.push("…");
      return `${baseName}(${truncated.join("")})`;
    };

    const pushRef = (name: string | null) => {
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed || trimmed.length >= 30) return;
      if (seen.has(trimmed)) return;
      seen.add(trimmed);
      refs.push(trimmed);
    };

    const extract = (n: TreeSitterNode) => {
      if (n.type === "call_expression" || n.type === "call") {
        const funcNode = getCallFunctionNode(n);
        let funcName = extractFunctionName(funcNode);
        if (funcName && langId === "swift") {
          funcName = formatSwiftFunction(funcName, n);
        }
        pushRef(funcName);
      } else if (
        n.type === "method_invocation" || // Java
        n.type === "invocation_expression" // C#
      ) {
        // Java/C# method calls
        const nameNode =
          n.childForFieldName?.("name") || n.childForFieldName?.("function");
        if (nameNode) {
          pushRef(nameNode.text);
        }
      } else if (
        n.type === "method_call" || // Ruby
        n.type === "command" || // Ruby
        n.type === "command_call" // Ruby
      ) {
        const nameNode =
          n.childForFieldName?.("method") || n.childForFieldName?.("name");
        if (nameNode) {
          pushRef(nameNode.text);
        }
      }

      for (const child of n.namedChildren || []) {
        extract(child);
      }
    };

    extract(node);
    return refs;
  }

  /**
   * Calculate cyclomatic complexity of a node.
   */
  private calculateComplexity(node: TreeSitterNode): number {
    let complexity = 1;
    const complexTypes = [
      "if_statement",
      "for_statement",
      "while_statement",
      "switch_statement",
      "catch_clause",
      "conditional_expression",
    ];

    const count = (n: TreeSitterNode) => {
      if (complexTypes.includes(n.type)) {
        complexity++;
      }
      if (n.type === "binary_expression") {
        const op = n.childForFieldName?.("operator");
        if (["&&", "||", "??"].includes(op?.text || "")) {
          complexity++;
        }
      }
      for (const child of n.namedChildren || []) {
        count(child);
      }
    };

    count(node);
    return complexity;
  }

  /**
   * Classify the role of a function based on its characteristics.
   */
  private classifyRole(complexity: number, refCount: number): string {
    // High complexity + many calls = orchestration
    if (complexity > 5 && refCount > 5) {
      return "ORCHESTRATION";
    }
    return "IMPLEMENTATION";
  }
}

/**
 * Convenience function to skeletonize a file.
 */
export async function skeletonizeFile(
  filePath: string,
  content: string,
  options?: SkeletonOptions,
): Promise<SkeletonResult> {
  const skeletonizer = new Skeletonizer();
  await skeletonizer.init();
  return skeletonizer.skeletonizeFile(filePath, content, options);
}
