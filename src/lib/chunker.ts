import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as https from "node:https";

// web-tree-sitter ships a CommonJS build
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser;
const Language = TreeSitter.Language;

const GRAMMARS_DIR = path.join(os.homedir(), ".osgrep", "grammars");

const GRAMMAR_URLS: Record<string, string> = {
    typescript: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.20.3/tree-sitter-typescript.wasm",
    tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.20.3/tree-sitter-tsx.wasm",
    python: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.20.4/tree-sitter-python.wasm",
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
            if (!url) return null; // Not supported

            try {
                console.log(`Downloading grammar for ${lang}...`);
                await this.downloadFile(url, wasmPath);
            } catch (e) {
                console.warn(`Could not download ${lang} grammar (offline?). Falling back to paragraph chunking.`);
                return null;
            }
        }

        try {
            const language = Language ? await Language.load(wasmPath) : null;
            this.languages.set(lang, language);
            return language;
        } catch (e) {
            console.error(`Failed to load grammar for ${lang}:`, e);
            return null;
        }
    }

    private downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    this.downloadFile(response.headers.location!, dest).then(resolve).catch(reject);
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => { });
                reject(err);
            });
        });
    }

    async chunk(filePath: string, content: string): Promise<Chunk[]> {
        if (!this.initialized) await this.init();
        if (!this.parser) return this.fallbackChunk(content);

        const ext = path.extname(filePath).toLowerCase();
        let lang = "";
        if (ext === ".ts") lang = "typescript";
        else if (ext === ".tsx") lang = "tsx";
        else if (ext === ".py") lang = "python";

        if (!lang) return this.fallbackChunk(content);

        const language = await this.getLanguage(lang);
        if (!language) return this.fallbackChunk(content);

        this.parser.setLanguage(language);
        const tree = this.parser.parse(content);

        const chunks: Chunk[] = [];

        // Simple traversal to find top-level functions and classes
        // TODO: Make this recursive or smarter based on language
        // For now, we iterate over children of root

        for (const child of tree.rootNode.children) {
            if (child.type === 'function_declaration' ||
                child.type === 'class_declaration' ||
                child.type === 'method_definition' ||
                child.type === 'function_definition' || // python
                child.type === 'class_definition' // python
            ) {
                chunks.push({
                    content: child.text,
                    startLine: child.startPosition.row,
                    endLine: child.endPosition.row,
                    type: child.type.includes('class') ? 'class' : 'function'
                });
            } else {
                // For other top level nodes, maybe group them?
                // For now, let's just take them if they are substantial
                if (child.text.length > 50) {
                    chunks.push({
                        content: child.text,
                        startLine: child.startPosition.row,
                        endLine: child.endPosition.row,
                        type: 'other'
                    });
                }
            }
        }

        // If no chunks found (e.g. file with just imports or small code), fallback
        if (chunks.length === 0) return this.fallbackChunk(content);

        return chunks;
    }

    private fallbackChunk(content: string): Chunk[] {
        // Paragraph split
        const paragraphs = content.split(/\n\s*\n/);
        const chunks: Chunk[] = [];
        let lineOffset = 0;

        for (const p of paragraphs) {
            if (!p.trim()) {
                lineOffset += p.split("\n").length;
                continue;
            }
            const numLines = p.split("\n").length;
            chunks.push({
                content: p,
                startLine: lineOffset,
                endLine: lineOffset + numLines,
                type: 'block'
            });
            lineOffset += numLines;
        }
        return chunks;
    }
}
