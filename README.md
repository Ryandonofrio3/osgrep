<div align="center">
  <h1>osgrep</h1>
  <p><em>Semantic search for your codebase.</em></p>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a><br>
</div>

Natural-language search that works like `grep`. Fast, local, and works with coding agents.

- **Semantic:** Finds concepts ("auth logic"), not just strings.
- **Local & Private:** 100% local embeddings via `transformers.js`.
- **Auto-Isolated:** Each repository gets its own index automatically.
- **Adaptive:** Runs fast on desktops, throttles down on laptops to prevent overheating.
- **Agent-Ready:** Native integration with Claude Code.

## Quick Start

1. **Install**
   ```bash
   npm install -g osgrep    # or pnpm / bun
   ```

2.  **Setup (Recommended)**

    ```bash
    osgrep setup
    ```

    Downloads embedding models (~150MB) upfront. If you skip this, models download automatically on first use.

3.  **Search**

    ```bash
    cd my-repo
    osgrep "where do we handle authentication?"
    ```

    **Your first search will automatically index the repository.** Each repository is automatically isolated with its own index. Switching between repos "just works" — no manual configuration needed. If the background server is running (`osgrep serve`), search goes through the hot daemon; otherwise it falls back to on-demand indexing.

## Coding Agent Integration

**Claude Code**

1. Run `osgrep install-claude-code`
2. Open Claude Code (`claude`) and ask it questions about your codebase.
3. The plugin’s hooks auto-start `osgrep serve` in the background and shut it down on session end. Claude will use `osgrep --json` via Bash for semantic searches automatically.

## Commands

### `osgrep search`

The default command. Searches the current directory using semantic meaning.

The CLI prefers the hot server when available (via `.osgrep/server.json`), falling back to standalone search automatically.

```bash
osgrep "how is the database connection pooled?"
```

**Options:**
| Flag | Description | Default |
| --- | --- | --- |
| `-m <n>` | Max total results to return. | `25` |
| `--per-file <n>` | Max matches to show per file. | `1` |
| `-c`, `--content` | Show full chunk content instead of snippets. | `false` |
| `--scores` | Show relevance scores (0.0-1.0). | `false` |
| `--compact` | Show file paths only (like `grep -l`). | `false` |
| `-s`, `--sync` | Force re-index changed files before searching. | `false` |
| `--json` | Dense output for agents. | `false` |

**Examples:**

```bash
# General concept search
osgrep "API rate limiting logic"

# Deep dive (show more matches per file)
osgrep "error handling" --per-file 5

# Just give me the files
osgrep "user validation" --compact
```

### `osgrep index`

Manually indexes the repository. Useful if you want to pre-warm the cache or if you've made massive changes outside of the editor.

- Respects `.gitignore` and `.osgrepignore` (see [Configuration](#ignoring-files) section).
- **Smart Indexing:** Only embeds code and config files. Skips binaries, lockfiles, and minified assets.
- **Adaptive Throttling:** Monitors your RAM and CPU usage. If your system gets hot, indexing slows down automatically.

```bash
osgrep index              # Index current dir
osgrep index --dry-run    # See what would be indexed
```

### `osgrep serve`

Runs a lightweight HTTP server with live file watching so searches stay hot in RAM.

- Keeps LanceDB and the embedding worker resident for <50ms responses.
- Watches the repo (via chokidar) and incrementally re-indexes on change.
- Health endpoint: `GET /health`
- Search endpoint: `POST /search` with `{ query, limit, path, rerank }`
- Writes lock: `.osgrep/server.json` with `port`/`pid`

Usage:

```bash
osgrep serve             # defaults to port 4444
OSGREP_PORT=5555 osgrep serve
```

Claude Code hooks start/stop this automatically; you rarely need to run it manually.

### `osgrep list`

Lists all indexed repositories (stores) and their metadata.

```bash
osgrep list
```

Shows store names, sizes, and last modified times. Useful for seeing what's indexed and cleaning up old stores.

### `osgrep doctor`

Checks installation health, model paths, and database integrity.

```bash
osgrep doctor
```

## Performance & Architecture

osgrep is designed to be a "good citizen" on your machine:

1.  **Bounded Concurrency:** Chunking/embedding stay within small thread pools (1–4) and capped batch sizes to keep laptops responsive (no dynamic throttling).
2.  **Smart Chunking:** Uses `tree-sitter` to split code by function/class boundaries, ensuring embeddings capture complete logical blocks.
3.  **Deduplication:** Identical code blocks (boilerplate, license headers) are embedded once and cached, saving space and time.
4.  **Hybrid Search:** Uses Reciprocal Rank Fusion (RRF) to combine Vector Search (semantic) with FTS (keyword) for best-of-both-worlds accuracy.
5.  **Global Batching:** A producer/consumer pipeline decouples chunking from embedding. Files are chunked concurrently, queued, embedded in fat batches, and written to LanceDB in bulk.
6.  **Anchor-Only Scans & Batch Deletes:** File discovery and stale cleanup hit only anchor rows, and stale/changed paths are removed with a single `IN` delete to minimize I/O.
7.  **Structural Boosting:** Function/class chunks get a small score boost; test/spec paths are slightly downweighted to bubble up primary definitions first.

## Configuration

### Automatic Repository Isolation

osgrep automatically creates a unique index for each repository based on:

1. **Git Remote URL** (e.g., `github.com/facebook/react` → `facebook-react`)
2. **Git Repo without Remote** → directory name + hash (e.g., `utils-7f8a2b3c`)
3. **Non-Git Directory** → directory name + hash for collision safety

**Examples:**
```bash
cd ~/work/myproject        # Auto-detected: owner-myproject
osgrep "API handlers"

cd ~/personal/utils        # Auto-detected: utils-abc12345
osgrep "helper functions"
```

Stores are isolated automatically — no manual `--store` flags needed!

### Ignoring Files

osgrep respects both `.gitignore` and `.osgrepignore` files when indexing. Create a `.osgrepignore` file in your repository root to exclude additional files or patterns from indexing.

**`.osgrepignore` syntax:**
- Uses the same pattern syntax as `.gitignore`
- Patterns are relative to the repository root
- Supports glob patterns, negation (`!`), and directory patterns (`/`)


### Manual Store Management

  - **View all stores:** `osgrep list`
  - **Override auto-detection:** `osgrep --store custom-name "query"`
  - **Clean up old stores:** `rm -rf ~/.osgrep/data/store-name`
  - **Data location:** `~/.osgrep/data`
  - **Env Vars:**
      - `MXBAI_STORE`: Override default store name
      - `OSGREP_PROFILE=1`: Enable performance profiling logs

## Development

```bash
pnpm install
pnpm build        # or pnpm dev
pnpm format       # biome check
```

## Troubleshooting

  - **Index feels stale?** Run `osgrep index` to refresh.
  - **Weird results?** Run `osgrep doctor` to verify models.
  - **Need a fresh start?** Delete `~/.osgrep/data` and re-index.

## Attribution

osgrep is built upon the foundation of [mgrep](https://github.com/mixedbread-ai/mgrep) by MixedBread. While approximately 90% of the current codebase has been rewritten or substantially modified to enable fully local operation, we acknowledge and appreciate the original architectural concepts and design decisions that informed this work.

Key transformations in osgrep include:
- Complete transition to local-only embeddings (no remote APIs)
- New local storage architecture with LanceDB
- Enhanced chunking, indexing, and watch mode capabilities
- Extensive tooling for benchmarking and evaluation

See the [NOTICE](NOTICE) file for detailed attribution information.

## License

Licensed under the Apache License, Version 2.0.  
See [LICENSE](LICENSE) and [Apache-2.0](https://opensource.org/licenses/Apache-2.0) for details.
