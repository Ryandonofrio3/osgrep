<div align="center">
  <h1>osgrep</h1>
  <p><em>A calm, CLI-native way to semantically grep everything, like code, images, pdfs and more.</em></p>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a><br>
</div>

## Why osgrep?
- Natural-language search that feels as immediate as `grep`.
- Semantic, multilingual & multimodal (audio, video support coming soon!)
- Smooth background indexing via `osgrep watch`, designed to detect and keep up-to-date everything that matters inside any git repository.
- 100% local embeddings (via `transformers.js`) with first-class coding agent integrations.
- Built for agents and humans alike, and **designed to be a helpful tool**, not a restrictive harness: quiet output, thoughtful defaults, and escape hatches everywhere.
- Reduces the token usage of your agent by 2x while maintaining superior performance

```bash
# index once
osgrep watch

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
   osgrep watch
   ```
   `watch` performs an initial sync, respects `.gitignore`, then keeps the local index updated as files change.

3. **Search anything**
   ```bash
   osgrep "where do we set up auth?" src/lib
   osgrep -m 25 "store schema"
   ```
   Searches default to the current working directory unless you pass a path.

Today, osgrep works great on: code and text documents.  
**Coming soon:** PDFs, images, audio, and video.

## Using it with Coding Agents

- **Claude Code (today)**  
  1. Run `osgrep install-claude-code`. The command installs the osgrep plugin into Claude Code.  
  2. Open Claude Code, enable the plugin, and point your agent at the repo you are indexing with `osgrep watch`.  
  3. Ask Claude something just like you do locally; results stream straight into the chat with file paths and line hints.  
  
- More agents (Codex, Cursor, Windsurf, etc.) are on the way—this section will grow as soon as each integration lands.

## Making your agent smarter

We plugged `osgrep` into Claude Code and ran a benchmark of 50 QA tasks to evaluate the economics of `osgrep` against `grep`.

![osgrep benchmark](assets/bench.jpg)

In our 50-task benchmark, `osgrep`+Claude Code used ~2x fewer tokens than grep-based workflows at similar or better judged quality.

`osgrep` finds the relevant snippets in a few semantic queries first, and the model spends its capacity on reasoning instead of scanning through irrelevant code from endless `grep` attempts. 

*Note: Win Rate (%) was calculated by using an LLM as a judge.*

## Why we built osgrep

`grep` is an amazing tool. It's lightweight, compatible with just about every machine on the planet, and will reliably surface any potential match within any target folder.

But grep is **from 1973**, and it carries the limitations of its era: you need exact patterns and it slows down considerably in the cases where you need it most, on large codebases.

Worst of all, if you're looking for deeply-buried critical business logic, you cannot describe it: you have to be able to accurately guess what kind of naming patterns would have been used by the previous generations of engineers at your workplace for `grep` to find it. This will often result in watching a coding agent desperately try hundreds of patterns, filling its token window, and your upcoming invoice, with thousands of tokens. 

But it doesn't have to be this way. Everything else in our toolkit is increasingly tailored to understand us, and so should our search tools. `osgrep` is our way to bring `grep` to 2025, integrating all of the advances in semantic understanding and code-search, without sacrificing anything that has made `grep` such a useful tool. 




## When to use what

We designed `osgrep` to complement `grep`, not replace it. The best code search combines `osgrep` with `grep`.

| Use `grep` (or `ripgrep`) for... | Use `osgrep` for... |
| --- | --- |
| **Exact Matches** | **Intent Search** |
| Symbol tracing, Refactoring, Regex | Code exploration, Feature discovery, Onboarding |


## Commands at a Glance

| Command | Purpose |
| --- | --- |
| `osgrep` / `osgrep search <pattern> [path]` | Natural-language search with many `grep`-style flags (`-i`, `-r`, `-m`...). |
| `osgrep watch` | Index the current repo and keep the local store in sync via file watchers. |
| `osgrep install-claude-code` | Add the osgrep plugin to Claude Code for local queries. |

### osgrep search

`osgrep search` is the default command. It can be used to search the current
directory for a pattern.

| Option | Description |
| --- | --- |
| `-m <max_count>` | The maximum number of results to return |
| `-c`, `--content` | Show content of the results |
| `-a`, `--answer` | Generate an answer to the question based on the results |
| `-s`, `--sync` | Sync the local files to the store before searching |

**Examples:**
```bash
osgrep "What code parsers are available?"  # search in the current directory
osgrep "How are chunks defined?" src/models  # search in the src/models directory
osgrep -m 10 "What is the maximum number of concurrent workers in the code parser?"  # limit the number of results to 10
osgrep -a "What code parsers are available?"  # generate an answer to the question based on the results
```

### osgrep watch

`osgrep watch` is used to index the current repository and keep the local
store in sync via file watchers.

It respects the current `.gitignore`, as well as a `.osgrepignore` file in the
root of the repository. The `.osgrepignore` file follows the same syntax as the
[`.gitignore`](https://git-scm.com/docs/gitignore) file.

**Examples:**
```bash
osgrep watch  # index the current repository and keep the local store in sync via file watchers
```

## Local-first under the hood

- Files are embedded locally with `transformers.js` and stored in `~/.osgrep/data` via LanceDB.
- Searches combine vector and FTS matches with reciprocal-rank fusion for relevance.
- Results include relative paths plus contextual hints (line ranges for text, page numbers for PDFs, etc.) for a skim-friendly experience.
- Everything runs offline; disconnect Wi‑Fi and it still works.

## Configuration Tips

- `--store <name>` lets you isolate workspaces (per repo, per team, per experiment). Stores are created on demand if they do not exist yet.
- Ignore rules come straight from git, so temp files, build outputs, and vendored deps stay out of your embeddings.
- `watch` reports progress (`processed / uploaded`) as it scans; leave it running in a terminal tab to keep your store fresh.
- `search` accepts most `grep`-style switches, and politely ignores anything it cannot support, so existing muscle memory still works.

**Environment Variables:**
- `MXBAI_STORE`: Override the default store name (default: `osgrep`)

## Development

```bash
pnpm install
pnpm build        # or pnpm dev for a quick compile + run
pnpm format       # biome formatting + linting
```

- The executable lives at `dist/index.js` (built from TypeScript via `tsc`).
- Husky is wired via `pnpx husky init` (run `npx husky init` once after cloning).
- Tests are not wired up yet—`pnpm typecheck` is your best friend before publishing.

## Troubleshooting

- **Watcher feels noisy**: set `MXBAI_STORE` or pass `--store` to separate experiments, or pause the watcher and restart after large refactors.
- **Need a fresh store**: delete `~/.osgrep/data/<store>` and run `osgrep watch`. It will auto-create a new one.

## License

Apache-2.0. See the [LICENSE](https://opensource.org/licenses/Apache-2.0) file for details.
