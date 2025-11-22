import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// web-tree-sitter ships a CommonJS build
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser;
const Language = TreeSitter.Language;

const GRAMMARS_DIR = path.join(os.homedir(), ".osgrep", "grammars");

const GRAMMAR_URLS: Record<string, string> = {
    typescript: "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-typescript.wasm",
    tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-tsx.wasm",
    python: "https://github.com/tree-sitter/tree-sitter-python/releases/latest/download/tree-sitter-python.wasm",
};

export interface Chunk {
    content: string;
    startLine: number;
    endLine: number;
    type: "function" | "class" | "block" | "other";
}

export class TreeSitterChunker {
    private parser: any = null;
    private languages: Map<string, any> = new Map();
    private initialized = false;
    
    // Safety Limits
    private readonly MAX_CHUNK_LINES = 60; 
    private readonly MAX_CHUNK_CHARS = 1500; 
    private readonly OVERLAP_LINES = 10;

    async init() {
        if (this.initialized) return;
        try {
            await Parser.init({
                locator: require.resolve("web-tree-sitter/tree-sitter.wasm"),
            });
            this.parser = new Parser();
        } catch (err) {
            console.error("Falling back to paragraph chunking; tree-sitter init failed:", err);
            this.parser = null;
        }
        if (!fs.existsSync(GRAMMARS_DIR)) {
            fs.mkdirSync(GRAMMARS_DIR, { recursive: true });
        }
        this.initialized = true;
    }

    private async getLanguage(lang: string): Promise<any> {
        if (this.languages.has(lang)) return this.languages.get(lang)!;
        const wasmPath = path.join(GRAMMARS_DIR, `tree-sitter-${lang}.wasm`);
        if (!fs.existsSync(wasmPath)) {
            const url = GRAMMAR_URLS[lang];
            if (!url) return null;
            try {
                console.log(`Downloading grammar for ${lang}...`);
                await this.downloadFile(url, wasmPath);
            } catch (e) {
                return null;
            }
        }
        try {
            const language = Language ? await Language.load(wasmPath) : null;
            this.languages.set(lang, language);
            return language;
        } catch (e) {
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
        
        // Step 1: Try TreeSitter for structural understanding
        let rawChunks: Chunk[] = [];
        if (this.parser) {
            try {
                rawChunks = await this.chunkWithTreeSitter(filePath, content);
            } catch (e) {
                // Fallback silently
            }
        }

        // Step 2: If TreeSitter failed or yielded nothing, use Text Fallback
        if (rawChunks.length === 0) {
            rawChunks = this.fallbackChunk(content);
        }

        // Step 3: Post-process "Giant Chunks" (The Safety Net)
        // This ensures NO giant function makes it to the model
        return rawChunks.flatMap(chunk => this.splitIfTooBig(chunk));
    }

    private async chunkWithTreeSitter(filePath: string, content: string): Promise<Chunk[]> {
        const ext = path.extname(filePath).toLowerCase();
        let lang = "";
        if (ext === ".ts") lang = "typescript";
        else if (ext === ".tsx") lang = "tsx";
        else if (ext === ".py") lang = "python";
        if (!lang) return [];

        const language = await this.getLanguage(lang);
        if (!language) return [];

        this.parser.setLanguage(language);
        const tree = this.parser.parse(content);
        const chunks: Chunk[] = [];

        // Flatten the logic: Just get top-level or near-top-level blocks
        const visit = (node: any) => {
            // If we found a function/class, capture it
            if ([
                "function_declaration", "function_definition",
                "method_definition", "class_declaration",
                "class_definition",
            ].includes(node.type)) {
                chunks.push({
                    content: node.text,
                    startLine: node.startPosition.row,
                    endLine: node.endPosition.row,
                    type: node.type.includes("class") ? "class" : "function"
                });
                return; // Don't recurse into this function (we handle splitting later)
            }

            // Otherwise, keep looking
            if (node.namedChildren) {
                for (const child of node.namedChildren) {
                    visit(child);
                }
            }
        };

        visit(tree.rootNode);
        return chunks;
    }

    // Force split anything that exceeds our limits
    private splitIfTooBig(chunk: Chunk): Chunk[] {
        const lineCount = chunk.endLine - chunk.startLine;
        const charCount = chunk.content.length;

        if (lineCount <= this.MAX_CHUNK_LINES && charCount <= this.MAX_CHUNK_CHARS) {
            return [chunk];
        }

        // It's too big. Slice it up using sliding windows.
        const subChunks: Chunk[] = [];
        const lines = chunk.content.split('\n');
        
        // Stride = Window - Overlap
        const stride = Math.max(1, this.MAX_CHUNK_LINES - this.OVERLAP_LINES);

        for (let i = 0; i < lines.length; i += stride) {
            const end = Math.min(i + this.MAX_CHUNK_LINES, lines.length);
            const subLines = lines.slice(i, end);
            
            // Don't create tiny fragments at the end
            if (subLines.length < 3 && i > 0) continue;

            const subContent = subLines.join('\n');
            subChunks.push({
                content: subContent,
                startLine: chunk.startLine + i,
                endLine: chunk.startLine + end,
                type: chunk.type
            });
        }
        return subChunks;
    }

    private fallbackChunk(content: string): Chunk[] {
        const lines = content.split("\n");
        const chunks: Chunk[] = [];
        const stride = this.MAX_CHUNK_LINES - this.OVERLAP_LINES;
        
        for (let i = 0; i < lines.length; i += stride) {
            const end = Math.min(i + this.MAX_CHUNK_LINES, lines.length);
            chunks.push({
                content: lines.slice(i, end).join("\n"),
                startLine: i,
                endLine: end,
                type: "block"
            });
        }
        return chunks;
    }
}