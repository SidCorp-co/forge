import { readdirSync } from "node:fs";
import path from "node:path";

// `worktrees`: an agent worktree is a full checkout, and counting one repeats every finding.
export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
  "worktrees",
]);

export const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

// The markup half of the family above. `.cts`/`.mts` pin a module format, which is what a build
// or tooling file does; a screen is not written in one, so scanning one buys a read and no finding.
export const DEFAULT_MARKUP_EXTENSIONS = [...SOURCE_EXTENSIONS].filter(
  (extension) => extension !== ".cts" && extension !== ".mts",
);

/**
 * One traversal, three answers — a per-directory count, the files, the package roots — because
 * written out per call site the ignore list lives in three places and agrees in none. A symlink
 * needs no test: `Dirent.isDirectory()` reads the link, not its target, so the tree cannot cycle.
 * `descend` runs before a child is queued, so a caller that stops at what it finds says so.
 */
export function* walkDirectories(
  roots,
  { ignoredDirectories = DEFAULT_IGNORED_DIRECTORIES, descend = () => true } = {},
) {
  const seen = new Set();
  const queue = roots.map((root) => path.resolve(root));

  while (queue.length > 0) {
    const directory = queue.shift();
    if (seen.has(directory)) continue;
    seen.add(directory);

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    yield { directory, entries };

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (descend(child)) queue.push(child);
    }
  }
}
