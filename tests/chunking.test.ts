import { describe, expect, it } from "vitest";
import {
  buildAnchorChunk,
  formatChunkText,
  TreeSitterChunker,
} from "../src/lib/index/chunker";

describe("TreeSitterChunker fallback and splitting", () => {
  it("splits large text into overlapping chunks with preserved ordering", async () => {
    const chunker = new TreeSitterChunker() as any;
    // Skip init and force fallback path
    chunker.initialized = true;
    chunker.parser = null;

    const lines = Array.from({ length: 220 }, (_, i) => `line-${i + 1}`);
    const content = lines.join("\n");

    const { chunks } = await chunker.chunk("file.ts", content);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].startLine).toBe(0);
    expect(chunks[0].endLine).toBeGreaterThan(chunks[0].startLine);
    // Ensure monotonic progression and overlap
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
      expect(chunks[i].endLine).toBeGreaterThan(chunks[i].startLine);
    }
  });

  it("splits very long single-line content by characters", async () => {
    const chunker = new TreeSitterChunker() as any;
    chunker.initialized = true;
    chunker.parser = null;

    const content = "a".repeat(3500);
    const { chunks } = await chunker.chunk("file.txt", content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(2000);
  });
});

describe("LocalStore chunk formatting helpers", () => {
  it("buildAnchorChunk includes imports, exports, and top comments", () => {
    const content = `// top comment
import fs from "fs";
export const value = 1;
function example() {}`;

    const anchor = buildAnchorChunk("src/example.ts", content, {
      imports: ["fs"],
      exports: ["value"],
      comments: ["// top comment"],
    });

    expect(anchor.isAnchor).toBe(true);
    expect(anchor.context).toContain("Anchor");
    expect(anchor.content).toContain("Imports:");
    expect(anchor.content).toContain("Exports: value");
    expect(anchor.content).toContain("Top comments:");
  });

  it("formatChunkText adds file breadcrumb when missing", () => {
    const { displayText } = formatChunkText(
      {
        content: "code",
        context: [],
        startLine: 0,
        endLine: 0,
        type: "other",
      },
      "/repo/path/file.ts",
    );
    expect(displayText).toContain("// File: /repo/path/file.ts");
    expect(displayText).toContain("code");
  });
});
