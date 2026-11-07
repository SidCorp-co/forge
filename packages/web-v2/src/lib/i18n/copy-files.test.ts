// @direct-test-of scripts/split-product-copy.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COPY_FILES } from "./copy-files";
import { composeCopy } from "./product-copy";

// The product copy is split into files each feature owns, so two lanes adding words to two features
// touch two files. These hold the split together: every copy file on disk is composed, a key lives in
// one file, and the one shared file it replaced stays gone. Forge is English only (the owner's ruling
// of 2026-10-08, ISS-1071): a copy file holds an `en` block alone, and composing one with any other
// language's block is refused naming the file, so the deleted `vi` words cannot come back unseen.

const SRC = resolve(__dirname, "../..");
const SPLIT = resolve(__dirname, "../../../../../scripts/split-product-copy.mjs");
const RETIRED = join(SRC, "lib/i18n/product-copy.json");
const FILES = COPY_FILES as Record<string, Record<string, Record<string, string>>>;

const onDisk = () => [
  ...readdirSync(join(SRC, "features"))
    .filter((dir) => existsSync(join(SRC, "features", dir, "copy.json")))
    .map((dir) => `features/${dir}/copy.json`),
  ...readdirSync(join(SRC, "lib/i18n/copy")).filter((n) => n.endsWith(".json")).map((n) => `lib/i18n/copy/${n}`),
];

/** The languages each copy file holds besides English, by file. */
const otherLanguages = (files: Record<string, Record<string, unknown>>): string[] =>
  Object.entries(files).flatMap(([file, part]) => Object.keys(part).filter((lang) => lang !== "en").map((lang) => `${file}: ${lang}`));

const splitCheck = (old: string) => spawnSync(process.execPath, [SPLIT, "--check", "--old", old], { encoding: "utf8" });

describe("the product copy files", () => {
  it("composes every copy file on disk, and none that is not", () => {
    const composed = new Set(Object.keys(FILES));
    expect(onDisk().filter((f) => !composed.has(f)), "a copy file copy-files.ts does not compose").toEqual([]);
    expect([...composed].filter((f) => !existsSync(join(SRC, f))), "a copy file copy-files.ts composes and the disk lacks").toEqual([]);
  });

  it("holds English alone in every copy file on disk", () => {
    expect(otherLanguages(FILES), "a copy file holds a language Forge no longer writes").toEqual([]);
  });

  it("refuses to compose a copy file holding another language, naming the file and the language", () => {
    const planted = { "lib/i18n/copy/a.json": { en: { "a.x": "Close" }, vi: { "a.x": "Dong" } } };
    expect(() => composeCopy(planted)).toThrow('Product copy file lib/i18n/copy/a.json holds a "vi" block: Forge is English only');
    expect(composeCopy({ "lib/i18n/copy/a.json": { en: { "a.x": "Close" } } })).toEqual({ en: { "a.x": "Close" } });
  });

  it("refuses a key two copy files hold, naming both", () => {
    const planted = { "features/a/copy.json": { en: { "a.x": "A" } }, "features/b/copy.json": { en: { "a.x": "B" } } };
    expect(() => composeCopy(planted)).toThrow('Product copy key "a.x" (en) is in both features/a/copy.json and features/b/copy.json');
  });

  it("keeps the retired product-copy.json out of the tree, naming each of its keys' home if it comes back", () => {
    const found = existsSync(RETIRED) ? splitCheck(RETIRED) : null;
    expect(found?.stderr ?? null, "src/lib/i18n/product-copy.json is retired").toBeNull();
  });

  it("names the copy file an edited key of a re-added product-copy.json belongs in", () => {
    const dir = mkdtempSync(join(tmpdir(), "product-copy-"));
    try {
      const old = join(dir, "product-copy.json");
      writeFileSync(old, JSON.stringify({ en: { "issues.brandNew": "Brand new", "settings.project.brandNew": "New" } }));
      const run = splitCheck(old);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("is retired");
      expect(run.stderr).toContain("en issues.brandNew → src/lib/i18n/copy/issues.json (new)");
      expect(run.stderr).toContain("en settings.project.brandNew → src/lib/i18n/copy/project-settings.json (new)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
