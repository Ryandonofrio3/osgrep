# osgrep – Practical Guide

`osgrep` is a semantic, grep‑like search tool for your local files. Instead of
matching exact keywords, it understands your natural-language questions and
finds relevant code, docs, and configuration across your repo.

This guide complements the main [`README`](../README.md) by focusing on
**practical, task-based workflows and examples**. If you just want installation
and a quick command overview, start with the main README. If you want to see how
to use osgrep in your day‑to‑day work, read on.

## TL;DR

```bash
npm install -g @ryandonofrio/osgrep    # or pnpm / bun
```

### Manual usage

```bash
cd path/to/repo                     # go to the project you want to index
osgrep watch                         # index and keep your store in sync

osgrep "What code parsers are available?"  # ask questions in natural language
osgrep -a "How is rate limiting implemented?"  # get a human and agent readable answer to the question
osgrep "What are the results of this paper?" my-paper.pdf  # search for PDF pages
```

### Claude Code usage

```bash
cd path/to/repo                     # go to the project you want to index
osgrep install-claude-code
claude
```

## How it works

At a high level, `osgrep` works in two steps:

1. **Index your files.**  
   When you run `osgrep watch` in a repo, `osgrep`:
   - Scans your files (respecting `.gitignore` and common build artifacts).
   - Embeds them locally and stores the vectors/FTS data in `~/.osgrep/data`.
   - Keeps that index up to date as files change via a file watcher.

2. **Search with natural language.**  
   - Reranks results so that the most useful matches appear first, even if the
     exact words you used never appear in the code.

Think of it as \"grep for meaning\": you describe what you are looking for in
plain language, and `osgrep` finds the parts of the repo that best answer that
description.

The claude code plugin will start to index the repo and keep the store in sync
automatically. No need to run `osgrep watch` manually.

### Example 1: Set up a repo for osgrep and an agent

```bash
cd ~/code/my-project

# 1. Install the osgrep plugin for claude code. The osgrep plugin will start to index the repo and keep the store in sync automatically.
osgrep install-claude-code

# 2. Ask questions while you work
osgrep "Where do we initialize the HTTP server?" src
osgrep "How is error handling wired up in the API layer?" src/api
```

Now open your editor or Claude Code and point the agent at `~/code/my-project`.
As you refactor, your index stays fresh automatically, so agent answers stay
grounded in the latest version of your code. No need to run `osgrep watch`
manually for claude code.

### Example 2: Classic `grep` vs osgrep

You know there is some authentication middleware, but you do not remember the exact
symbol or file name. With classic `grep` you might try:

```bash
# Searching for any mention of "auth"
grep -R "auth" src
```

This can be noisy, especially in large repos or where the concept you care about is
implemented under different names.

With `osgrep`, you describe what you mean instead of guessing the exact keyword:

```bash
# Search semantically within src
osgrep "Where is the auth middleware configured?" src

# Limit to the top 5 most relevant matches (the default is 10)
osgrep -m 5 "Where is the auth middleware configured?" src

# Get a human and agent readable answer to the question
osgrep -a "Where is the auth middleware configured?" src
```

Because `osgrep` searches by meaning, it can surface files like `auth_middleware.ts`,
`session.ts`, or `passport-setup.js` even if they never contain the literal phrase
\"auth middleware\".

### Example 3: Asking higher‑level questions

Semantic search becomes even more powerful when you use it to explore architecture
and behavior, not just symbols. For example, in a new repo you might ask:

```bash
# Explore how background jobs work
osgrep -m 15 "How are background jobs scheduled?"

# See content around the matches to skim quickly
osgrep -c "Where do we validate user input for the signup form?"

# Let osgrep summarize across results
osgrep -a "How does rate limiting work in this service?"
```

- `-m` controls how many results you see.  
- `-c` prints the surrounding content for each match so you can skim without opening files.  
- `-a` asks `osgrep` to generate an answer based on the retrieved context, which is helpful
  when you want a narrative explanation rather than a list of matches.

### Example 4: Searching PDFs and other non-code files

`osgrep` can be used to search other file types than just code. For example, you
can search PDFs:

```bash
osgrep "What is the conclusion of the paper?" my-paper.pdf
```

This will return the most relevant pages from the PDF in order of relevance.

## Further reading

- Main project overview and full command list: [`../README.md`](../README.md)  
