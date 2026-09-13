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
import ts from "typescript";
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
 * Every name a file's CODE uses: each identifier, plus each `A.b` property access written on an
 * identifier, taken off the parse tree.
 *
 * Several of the files below NAME the deleted symbols on purpose — a `cm:guard` saying what went
 * and why is the record that stops it coming back a third time, and a scan that counted those as
 * violations would push every one of them out of the tree. So comments do not count. This asks the
 * compiler's own parser rather than stripping comments with a regex: a regex stripper reads the
 * `//` inside `"https://host"` as the start of a comment and erases the rest of that line,
 * including whatever real declaration follows it, which is a FALSE PASS — the one failure mode a
 * negative test must not have. `codeNames` is exercised on exactly those shapes below.
 */
function codeNames(body: string, file: string): Set<string> {
  const names = new Set<string>();
  const source = ts.createSourceFile(
    file,
    body,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isIdentifier(node.name)
    ) {
      names.add(`${node.expression.text}.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Every .ts/.tsx under web-v2's `src`, minus this file, as `[path, names-its-code-uses]`. */
const FILES: [string, Set<string>][] = sourceFiles(SRC)
  .map(
    (f) =>
      [relative(SRC, f), codeNames(readFileSync(f, "utf8"), f)] as [
        string,
        Set<string>,
      ],
  )
  .filter(([path]) => path !== THIS_FILE);

function hits(name: string): string[] {
  return FILES.filter(([, names]) => names.has(name)).map(([path]) => path);
}

describe("no status→stage ladder survives in web-v2", () => {
  it("finds enough files to be looking at the real tree", () => {
    // cm:guard guards the scan itself — a walk that silently matched nothing would pass every case below
    expect(FILES.length).toBeGreaterThan(200);
    expect(hits("statusToChip")).not.toHaveLength(0);
  });

  it("declares no map from an issue status to a pipeline stage", () => {
    expect(hits("STATUS_TO_STAGE")).toEqual([]);
  });

  it("has no `statusToStage`, in either feature module or anywhere else", () => {
    expect(hits("statusToStage")).toEqual([]);
  });

  it("has no seven-bead tracker to feed", () => {
    expect(hits("PipelineTracker")).toEqual([]);
  });

  it("has no index over the stage names, because an index is an order", () => {
    expect(hits("STAGE_INDEX")).toEqual([]);
  });

  it("renders no `N / 7` progress figure against the seven stages", () => {
    expect(hits("STAGES.length")).toEqual([]);
  });
});

describe("the scan itself cannot be fooled", () => {
  const named = (body: string) => codeNames(body, "fixture.ts");

  it("still sees a declaration on a line that holds a `//` inside a string", () => {
    expect(named('const u = "https://host"; const STATUS_TO_STAGE = {};')).toContain("STATUS_TO_STAGE");
  });

  it("still sees one after a `/*` carried inside a string or a template", () => {
    expect(named('const a = "/* not a comment"; function statusToStage() {}')).toContain("statusToStage");
    expect(named(`const t = \`/* \${x} */\`; const STAGE_INDEX = 1;`)).toContain("STAGE_INDEX");
  });

  it("still sees one after a regex literal holding a comment delimiter", () => {
    expect(named("const r = /\\/\\*|\\/\\//g; const n = STAGES.length;")).toContain("STAGES.length");
  });

  it("does not count a name that appears only in a comment", () => {
    expect(named("// STATUS_TO_STAGE went in ISS-999\nexport const x = 1;")).not.toContain("STATUS_TO_STAGE");
    expect(named("/** PipelineTracker was deleted. */\nexport const y = 2;")).not.toContain("PipelineTracker");
  });

  it("does not count a name that appears only inside a string", () => {
    expect(named('const s = "statusToStage";')).not.toContain("statusToStage");
  });
});
