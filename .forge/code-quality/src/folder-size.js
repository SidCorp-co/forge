import path from "node:path";

import { DEFAULT_IGNORED_DIRECTORIES, SOURCE_EXTENSIONS, walkDirectories } from "./walk.js";

export const DEFAULT_MAX_FILES_PER_DIRECTORY = 10;

/**
 * Counts source files directly inside each directory, never recursively: a
 * folder that grew wide is the finding, and its subfolders are the fix.
 */
export function findCrowdedDirectories({
  roots = ["."],
  max = DEFAULT_MAX_FILES_PER_DIRECTORY,
  ignoredDirectories = DEFAULT_IGNORED_DIRECTORIES,
  extensions = SOURCE_EXTENSIONS,
} = {}) {
  const violations = [];
  for (const { directory, entries } of walkDirectories(roots, { ignoredDirectories })) {
    const count = entries.filter(
      (entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()),
    ).length;
    if (count > max) violations.push({ directory, count });
  }
  return violations.sort((a, b) => b.count - a.count || a.directory.localeCompare(b.directory));
}
