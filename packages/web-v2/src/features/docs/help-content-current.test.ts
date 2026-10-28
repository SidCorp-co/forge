/**
 * ISS-1421 r41 (judge-167) — every help test reads the bundled module, and nothing held that module
 * to content/help: a quote edited into the page alone left the suite green while the next build
 * served it. The generator's own `--check` is the tie, run here against the tree and a planted copy.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../../..");
const SCRIPT = join(WEB, "scripts", "gen-help-content.mjs");
const CONTENT = join(WEB, "content", "help");
const GENERATED = join(WEB, "src", "features", "docs", "help-content.generated.ts");

function check(from?: string) {
  const args = [SCRIPT, "--check", ...(from ? ["--from", from] : [])];
  return spawnSync("node", args, { encoding: "utf8" });
}

describe("the bundled help, against content/help", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("matches the pages it is generated from", () => {
    const r = check();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("is refused, naming the stale file, when a page is edited without regenerating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "help-check-"));
    made.push(dir);
    cpSync(CONTENT, dir, { recursive: true });
    const page = join(dir, "what-done-means.md");
    const said = readFileSync(page, "utf8");
    expect(said).toContain("What will change once it is released");
    writeFileSync(page, said.replace("What will change once it is released", "What will change once it goes live"));

    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/features/docs/help-content.generated.ts does not match content/help/");
    expect(r.stderr).toContain("pnpm gen:help");
  });

  it("writes nothing when it checks", () => {
    const before = readFileSync(GENERATED, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "help-check-"));
    made.push(dir);
    cpSync(CONTENT, dir, { recursive: true });
    writeFileSync(join(dir, "what-done-means.md"), "---\ntitle: X\naudience: user\n---\nBody\n");
    check(dir);
    expect(readFileSync(GENERATED, "utf8")).toBe(before);
  });
});
