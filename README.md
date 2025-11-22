<div align="center">
  <h1>osgrep</h1>
  <p><em>Semantic search for your codebase.</em></p>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a><br>
</div>

Natural-language search that works like `grep`. Fast, local, and works with coding agents.

- Semantic, multilingual & multimodal
- On-demand indexing for fast repeated searches
- 100% local embeddings via `transformers.js`
- Integrates with coding agents

```bash
# index once
osgrep index

# then ask your repo things in natural language
osgrep "where do we set up auth?"
```

## Quick Start

1. **Install**
   ```bash
   npm install -g @ryandonofrio/osgrep    # or pnpm / bun
   ```

2. **Index a project**
   ```bash
   cd path/to/repo
   osgrep index
   ```
   `index` performs a one-time sync, respects `.gitignore`, and creates a local searchable index.

3. **Search anything**
   ```bash
   osgrep "where do we set up auth?" src/lib
   osgrep -m 25 "store schema"
   ```
   Searches default to the current working directory unless you pass a path.

Today, osgrep works great on: code and text documents.  
**Coming soon:** PDFs, images, audio, and video.

## Coding Agent Integration

**Claude Code**  
1. Run `osgrep install-claude-code`
2. Run `osgrep index` to index your repository
3. Open Claude Code, enable the plugin, and point it at your indexed repo
4. Results stream into the chat with file paths and line hints
  
More agents coming soon (Codex, Cursor, Windsurf, etc.).


## When to use what

`osgrep` complements `grep`. Use both.

| Use `grep` (or `ripgrep`) for... | Use `osgrep` for... |
| --- | --- |
| **Exact Matches** | **Intent Search** |
| Symbol tracing, Refactoring, Regex | Code exploration, Feature discovery, Onboarding |


## Commands at a Glance

| Command | Purpose |
| --- | --- |
| `osgrep` / `osgrep search <pattern> [path]` | Natural-language search with many `grep`-style flags (`-i`, `-r`, `-m`...). |
| `osgrep index` | Index the current repo to create a local searchable store. |
| `osgrep install-claude-code` | Add the osgrep plugin to Claude Code for local queries. |

### osgrep search

`osgrep search` is the default command. Searches the current directory for a pattern.

| Option | Description |
| --- | --- |
| `-m <max_count>` | The maximum number of results to return |
| `-c`, `--content` | Show content of the results |
| `-s`, `--sync` | Sync the local files to the store before searching (always fresh but slower) |

**Examples:**
```bash
osgrep "What code parsers are available?"  # search in the current directory
osgrep "How are chunks defined?" src/models  # search in the src/models directory
osgrep -m 10 "What is the maximum number of concurrent workers in the code parser?"  # limit the number of results to 10
osgrep --sync "latest auth changes"  # always fresh but slower
```

**Workflow:**
- `osgrep --sync "query"` = always fresh but slower
- `osgrep index` then `osgrep "query"` = fast repeated searches

### osgrep index

Indexes the current repository and creates a local searchable store. Run once per repository or when refreshing the index.

It respects the current `.gitignore`, as well as a `.osgrepignore` file in the
root of the repository. The `.osgrepignore` file follows the same syntax as the
[`.gitignore`](https://git-scm.com/docs/gitignore) file.

| Option | Description |
| --- | --- |
| `-d`, `--dry-run` | Dry run the indexing process (no actual file syncing) |
| `-p`, `--path <dir>` | Path to index (defaults to current directory) |

**Examples:**
```bash
osgrep index  # index the current repository
osgrep index --path src/lib  # index a specific subdirectory
osgrep index --dry-run  # see what would be indexed without actually indexing
```

### osgrep index

It respects the current `.gitignore`, as well as a `.osgrepignore` file in the
root of the repository.

## How it works

- Files are embedded locally with `transformers.js` and stored in `~/.osgrep/data` via LanceDB.
- Searches combine vector and FTS matches with reciprocal-rank fusion.
- Results include relative paths plus contextual hints (line ranges for text, page numbers for PDFs, etc.).
- Runs offline.

## Configuration

- `--store <name>` isolates workspaces (per repo, per team, per experiment). Stores are created on demand.
- Ignore rules come from git, so temp files, build outputs, and vendored deps stay out of embeddings.
- `index` reports progress (`processed / uploaded`) as it scans.
- `search` accepts most `grep`-style switches.

**Environment Variables:**
- `MXBAI_STORE`: Override the default store name (default: `osgrep`)

## Development

```bash
pnpm install
pnpm build        # or pnpm dev for a quick compile + run
pnpm format       # biome formatting + linting
```

- Executable at `dist/index.js` (built from TypeScript via `tsc`).
- Run `npx husky init` once after cloning.
- Tests not wired up yet—run `pnpm typecheck` before publishing.

## Troubleshooting

- **Index feels stale**: run `osgrep index` again after large refactors.
- **Need a fresh store**: delete `~/.osgrep/data/<store>` and run `osgrep index`.

## License

Apache-2.0. See the [LICENSE](https://opensource.org/licenses/Apache-2.0) file for details.
