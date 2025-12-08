import { describe, it, expect, beforeEach } from "vitest";
import { TreeSitterChunker } from "../src/lib/index/chunker";

// Mock config to ensure we are testing expected thresholds, 
// though we'll rely on the default logic which we are about to change.
// We can't easily mock the const imports from config without module mocking,
// so we'll construct the Chunker and rely on its internal constants.

describe("TreeSitterChunker - Large Data Files", () => {
    let chunker: TreeSitterChunker;

    beforeEach(() => {
        chunker = new TreeSitterChunker();
        // Force init chunks
        return chunker.init();
    });

    it("should chunk a small JSON file using fallback", async () => {
        const content = JSON.stringify({ name: "osgrep", version: "1.0.0" }, null, 2);
        const result = await chunker.chunk("package.json", content);
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.chunks[0].content).toContain("osgrep");
    });

    it("should NOT chunk a large generated JSON file (>100KB)", async () => {
        // Create >100KB JSON content
        const largeObject = {
            data: Array(5000).fill({
                id: "1234567890",
                value: "some repeated string content to bloat the file size significantly"
            })
        };
        const content = JSON.stringify(largeObject, null, 2);
        // Sanity check size
        expect(Buffer.byteLength(content)).toBeGreaterThan(100 * 1024);

        const result = await chunker.chunk("large_data.json", content);

        // This expectation will FAIL before the fix, enabling us to verify the fix works.
        // Before fix: it falls back to text chunking and returns many chunks.
        // After fix: it should return 0 chunks.
        expect(result.chunks.length).toBe(0);
    });

    it("should chunk a large source file (TS) normally", async () => {
        // Create >100KB TS content. 
        // Even without tree-sitter available (if it fails to load), 
        // we might fallback, BUT the requirement is specifically to skip DATA files.
        // Source code should probably still be attempted or handled differently.
        // For now, let's verify we don't regress on source code.
        const line = `export const v${Math.random()} = "some value";\n`;
        const content = line.repeat(3000);
        expect(Buffer.byteLength(content)).toBeGreaterThan(100 * 1024);

        const result = await chunker.chunk("giant_source.ts", content);
        // Should still try to chunk source code
        expect(result.chunks.length).toBeGreaterThan(0);
    });
});
