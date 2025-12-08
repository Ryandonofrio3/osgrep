import * as fs from "node:fs/promises";
import { Dirent } from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";
import { DEFAULT_IGNORE_PATTERNS } from "./ignore-patterns";

interface WalkOptions {
    ignoreFiles?: string[];
    additionalPatterns?: string[];
}

interface IgnoreScope {
    filter: Ignore;
    dir: string; // Absolute path of this scope's root
}

async function getIgnoreFilter(
    dir: string,
    ignoreFiles: string[],
): Promise<Ignore | null> {
    let filter: Ignore | null = null;

    for (const fileName of ignoreFiles) {
        const ignorePath = path.join(dir, fileName);
        try {
            const content = await fs.readFile(ignorePath, "utf-8");
            if (!filter) filter = ignore();
            filter.add(content);
        } catch (err) {
            // Ignore missing files
        }
    }

    return filter;
}

export async function* walk(
    rootDir: string,
    options: WalkOptions = {},
): AsyncGenerator<string> {
    const ignoreFiles = options.ignoreFiles || [".gitignore", ".osgrepignore"];
    const rootParams = ignore().add(DEFAULT_IGNORE_PATTERNS);
    if (options.additionalPatterns) {
        rootParams.add(options.additionalPatterns);
    }

    // Initial scope for root
    const rootScope: IgnoreScope = {
        filter: rootParams,
        dir: rootDir,
    };

    // Stack of scopes. 
    // We check against ALL scopes in the stack. 
    // This implements the "additive" ignore behavior (files ignored by parent are ignored by child).
    // Note: This does not strictly support "un-ignoring" a parent rule via a child .gitignore 
    // (because we check parent independently), but it is the safest robust implementation for "hiding" nested files.
    const stack: IgnoreScope[] = [rootScope];

    // We also try to load root .gitignore immediately to add to the stack
    const rootGitIgnore = await getIgnoreFilter(rootDir, ignoreFiles);
    if (rootGitIgnore) {
        stack.push({ filter: rootGitIgnore, dir: rootDir });
    }

    yield* _walk(rootDir, rootDir, stack, ignoreFiles);
}

async function* _walk(
    currentDir: string,
    rootDir: string,
    stack: IgnoreScope[],
    ignoreFiles: string[],
): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
        return;
    }

    for (const entry of entries) {
        const absPath = path.join(currentDir, entry.name);
        const relPathToRoot = path.relative(rootDir, absPath);

        // 1. Check if ignored by any scope in the stack
        let isIgnored = false;
        for (const scope of stack) {
            const relToScope = path.relative(scope.dir, absPath);
            if (relToScope && scope.filter.ignores(relToScope)) {
                isIgnored = true;
                break;
            }
        }

        if (isIgnored) continue;

        if (entry.isDirectory()) {
            // 2. Prepare scope for the new directory
            const childIgnore = await getIgnoreFilter(absPath, ignoreFiles);
            if (childIgnore) {
                // Push new scope
                stack.push({ filter: childIgnore, dir: absPath });
                yield* _walk(absPath, rootDir, stack, ignoreFiles);
                stack.pop();
            } else {
                // Just recurse with same stack
                yield* _walk(absPath, rootDir, stack, ignoreFiles);
            }
        } else {
            yield relPathToRoot;
        }
    }
}
