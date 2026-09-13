// The ladder does not come back — a scan of web-v2's own source (ISS-999).
//
// This is a NEGATIVE over a whole tree, which no import graph can express, so it walks the files.
// It exists because the projection it forbids came back once already: `STATUS_TO_STAGE` was
// "ported from the project overview's STATUS_TO_STAGE" into `features/issues/derive.ts`, then
// ported again into `features/pipeline/derive.ts`, and by the time ISS-999 was filed the two copies
// had drifted to 17 keys and 15 — the second answering `triage` for `releasing` and `dropped`
// while its neighbour answered `release`. One of them carried a `cm:guard` reading "`dropped` has
// no stage" on the line directly above `dropped: "triage"`.
//
// ISS-897 deleted the seven-stage lane from the kernel. A status says what is true of an issue
// now; nothing derives a position or a denominator from it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const THIS_FILE = relative(SRC, __filename);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments out. Several of the files below NAME the deleted symbols on purpose — a `cm:guard`
 * saying what went and why is the record that stops it coming back a third time, and a scan that
 * counted those as violations would push every one of them out of the tree.
 */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Every .ts/.tsx under web-v2's `src`, minus this file, as `[path, code-with-comments-stripped]`. */
const FILES: [string, string][] = sourceFiles(SRC)
  .map((f) => [relative(SRC, f), code(readFileSync(f, "utf8"))] as [string, string])
  .filter(([path]) => path !== THIS_FILE);

function hits(pattern: RegExp): string[] {
  return FILES.filter(([, body]) => pattern.test(body)).map(([path]) => path);
}

describe("no status→stage ladder survives in web-v2", () => {
  it("finds enough files to be looking at the real tree", () => {
    // cm:guard guards the scan itself — a walk that silently matched nothing would pass every case below
    expect(FILES.length).toBeGreaterThan(200);
    expect(hits(/statusToChip/)).not.toHaveLength(0);
  });

  it("declares no map from an issue status to a pipeline stage", () => {
    expect(hits(/STATUS_TO_STAGE/)).toEqual([]);
  });

  it("has no `statusToStage`, in either feature module or anywhere else", () => {
    expect(hits(/\bstatusToStage\b/)).toEqual([]);
  });

  it("has no seven-bead tracker to feed", () => {
    expect(hits(/\bPipelineTracker\b/)).toEqual([]);
  });

  it("has no index over the stage names, because an index is an order", () => {
    expect(hits(/\bSTAGE_INDEX\b/)).toEqual([]);
  });

  it("renders no `N / 7` progress figure against the seven stages", () => {
    expect(hits(/STAGES\.length/)).toEqual([]);
  });
});
