import {
  buildDocumentPatch,
  isPlainObject,
  patchLeafPaths,
  readPath,
} from "@forge/contracts/document-patch";
import type { DocumentWrite } from "./types";

/** The stored value at every leaf the patch writes, laid out as the document lays them out. */
function baseAt(stored: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const path of patchLeafPaths(patch)) {
    const value = readPath(stored, path);
    if (value === undefined) continue;
    let cursor = base;
    for (const segment of path.slice(0, -1)) {
      const next = cursor[segment];
      if (isPlainObject(next)) cursor = next;
      else {
        const made: Record<string, unknown> = {};
        cursor[segment] = made;
        cursor = made;
      }
    }
    cursor[path[path.length - 1] as string] = value;
  }
  return base;
}

/**
 * The write a page owes: the keys its draft moved, and the values the store held at them. The base
 * comes from the document itself, so a default the draft filled in is never taken for a stored
 * value. Null where nothing moved.
 */
export function documentWrite(seeded: unknown, held: unknown, stored: unknown): DocumentWrite | null {
  const { patch } = buildDocumentPatch(seeded, held);
  if (Object.keys(patch).length === 0) return null;
  return { patch, base: baseAt(stored, patch) };
}
