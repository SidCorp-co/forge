
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
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function codeNames(body: string, file: string): Set<string> {
  const names = new Set<string>();
  const source = ts.createSourceFile(
    file,
    body,
    ts.ScriptTarget.Latest,
    false,
    /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  /** `a.b.c` and `a["b"].c` as the dotted chain they read as, or null for anything computed. */
  const chain = (node: ts.Node): string | null => {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const head = chain(node.expression);
      return head === null ? null : `${head}.${node.name.text}`;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const head = chain(node.expression);
      return head === null ? null : `${head}.${node.argumentExpression.text}`;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (ts.isStringLiteralLike(node) && ts.isElementAccessExpression(node.parent ?? node)) {
      names.add(node.text);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const full = chain(node);
      if (full !== null) {
        const parts = full.split(".");
        for (let i = 0; i < parts.length; i++) names.add(parts.slice(i).join("."));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Every source file under web-v2's `src`, minus this file, as `[path, names-its-code-uses]`. */
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

  it("reads a compound chain as the shorter name a reader would check for", () => {
    expect(named("const n = registry.STAGES.length;")).toContain("STAGES.length");
  });

  it("reads a bracketed string key as the name it names", () => {
    expect(named('const m = globalThis["STATUS_TO_STAGE"];')).toContain("STATUS_TO_STAGE");
    expect(named('const m = registry["STAGES"].length;')).toContain("STAGES.length");
  });
});
