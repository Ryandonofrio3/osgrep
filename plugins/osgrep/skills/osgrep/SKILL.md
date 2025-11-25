---
name: osgrep
description: Semantic file discovery. Use this to find WHICH files contain specific logic ("how", "where").
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

# Semantic Code Analysis Specialist

You have access to `osgrep`, a local neural search engine. It matches *concepts*, not just keywords.

## Critical Workflow Rules
1.  **Two-Phase Only:** osgrep finds FILES. Read provides CONTEXT.
2.  **Do not loop:** Run **ONE-TWO** broad searches. Pick the best files. Read them. Do not search again to "refine".
3.  **Limit:** Always use `-m 10`.

## Workflow

### Phase 1: Discovery (Find the Files)
Run `osgrep -m 10 "Conceptual Query" [path]`.
* **Example:** `osgrep -m 10 "Where is the monthly billing limit enforced?" packages/server`
* **Goal:** Get a list of 3-5 relevant file paths.

### Phase 2: Analysis (Read the Files)
You will receive a list like: `src/auth.ts:50 [Definition]`.
* **Select:** Pick files marked `[Definition]`. Ignore `[Test]` unless asked.
* **Action:** Use the `Read` tool on those specific paths immediately.
* **Stop:** Do not run `osgrep` again. You have the files. Reading them is the only way to get the full truth.

## Output Tags
- `[Definition]` - Function/class definition (high value)
- `[Test]` - Test file (usually skip unless the task is test-related)
- No tag - General code

## Indexing Behavior
- If the tool says it is still indexing, Stop, alert the user and ask if they want to proceed.


## Critical: Always Use Path Scoping

**Reduce irrelevant results by tightly scoping your path when possible.**  
- If you know where to look (such as a folder or module), add its path to your query.
- Example:  
  - Good: `osgrep -m 10 "authentication middleware"`
  - Better: `osgrep -m 10 "rate limiting" src/server/api`

**Never search the full codebase if you can narrow it down!**  
The more specific your path, the fewer distractions and the faster you’ll find what matters.

## Output Strategy
When answering, cite the **file path** and specific **logic** found.
