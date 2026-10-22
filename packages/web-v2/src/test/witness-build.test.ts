// The screen witness bundles an entry the way a run does and opens it from file://. web-v2 declares
// every module but its stylesheets free of side effects, so the app's bundle keeps only the parts
// of the design kit a page uses, and an entry is nothing but side effects, imported bare. Since the
// web left Next.js (dev.232) the bundler dropped every entry whole: app.js was empty, the page ran
// nothing, and the run said only "set no window.__witness.cases". An entry is built here inside a
// package that declares the same, and its bundle must still run it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { buildPage } from "../../witness/build-page.mjs";

const home = mkdtempSync(join(tmpdir(), "witness-build-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A package declaring what web-v2 declares, holding one entry whose only act is its effect. */
function entryUnderSideEffectsDeclaration(body = 'globalThis.__witness = { cases: [{ name: "probe", width: 390 }] };\n'): string {
  const pkg = join(home, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "witness-probe", type: "module", sideEffects: ["**/*.css"] }));
  const entry = join(pkg, "probe.witness.ts");
  writeFileSync(entry, body);
  return entry;
}

type Page = { __witness?: { cases?: { name: string }[]; mascot?: string; route?: string }; window?: unknown; process?: unknown };

/** Build an entry as a run does and run its app.js, answering what it set on the page. */
async function built(entry: string): Promise<Page> {
  const out = join(home, "out");
  mkdirSync(out, { recursive: true });
  await buildPage(entry, out);
  const app = readFileSync(join(out, "app.js"), "utf8");
  expect(app.length, "the entry was dropped and app.js is empty").toBeGreaterThan(0);
  const page: Page = {};
  page.window = page;
  page.process = { env: { NODE_ENV: "production" } };
  runInNewContext(app, page);
  return page;
}

describe("the witness page's bundle", () => {
  it("runs an entry the package declares free of side effects, as every web-v2 entry is", async () => {
    const page = await built(entryUnderSideEffectsDeclaration());
    expect(page.__witness?.cases?.map((c) => c.name), "the bundle loaded and the entry never ran").toEqual(["probe"]);
  }, 180_000);

  // the page is opened from file://, where the path core serves the mascot at is the disk's root: the
  // mascot drew broken, its alt text "Forge" in its place, on every witness shot of a loading read
  it("carries the pictures the app names under public/ inside the bundle, and leaves a route its own path", async () => {
    const page = await built(
      entryUnderSideEffectsDeclaration(
        'import { assetPath } from "@/lib/asset";\nglobalThis.__witness = { mascot: assetPath("/forge-mark-180.png"), route: assetPath("/login") };\n',
      ),
    );
    const mascot = readFileSync(join(__dirname, "../../public/forge-mark-180.png")).toString("base64");
    expect(page.__witness?.mascot, "the mascot is named by a path a file:// page cannot read").toBe(`data:image/png;base64,${mascot}`);
    expect(page.__witness?.route).toBe("/login");
  }, 180_000);
});
