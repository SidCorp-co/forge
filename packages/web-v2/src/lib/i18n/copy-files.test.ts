import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SAID_ENTRIES } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { COPY_FILES } from "./copy-files";
import { composeCopy } from "./product-copy";

// The product copy is split into files each feature owns, so two lanes adding words to two features
// touch two files. These hold the split together: every copy file on disk is composed, a key lives in
// one file, a vi word stands beside its English and is never blank where the English is not, and the
// one shared file it replaced stays gone. A key may be English only: Forge is not multilingual (the
// owner's ruling of 2026-10-08), so a new key carries no vi and reads in English on a vi page.

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

/** A vi word with no English beside it, or blank where its English is not, by file and key; English-only keys pass. */
function strayWords(files: Record<string, Record<string, Record<string, string>>>): string[] {
  const wrong: string[] = [];
  for (const [file, part] of Object.entries(files)) {
    const en = part.en ?? {};
    for (const [key, text] of Object.entries(part.vi ?? {})) {
      const english = key in en ? en[key] : SAID_ENTRIES[key as keyof typeof SAID_ENTRIES]?.en;
      if (english === undefined) wrong.push(`${file}: ${key} has vi and no en`);
      else if (!text.trim() && english.trim()) wrong.push(`${file}: ${key} is blank in vi and not in en`);
    }
  }
  return wrong;
}

const splitCheck = (old: string) => spawnSync(process.execPath, [SPLIT, "--check", "--old", old], { encoding: "utf8" });

describe("the product copy files", () => {
  it("composes every copy file on disk, and none that is not", () => {
    const composed = new Set(Object.keys(FILES));
    expect(onDisk().filter((f) => !composed.has(f)), "a copy file copy-files.ts does not compose").toEqual([]);
    expect([...composed].filter((f) => !existsSync(join(SRC, f))), "a copy file copy-files.ts composes and the disk lacks").toEqual([]);
  });

  it("keeps a vi word beside its English in the same file, a vi key with no English being one core says", () => {
    expect(strayWords(FILES), "a vi word stands beside its English").toEqual([]);
  });

  it("refuses a vi word with no English, and a blank one whose English is not blank, naming the file and key", () => {
    const planted = { "features/a/copy.json": { en: { "a.x": "Close", "a.y": "Open" }, vi: { "a.x": " ", "a.z": "Z" } } };
    expect(strayWords(planted)).toEqual(["features/a/copy.json: a.x is blank in vi and not in en", "features/a/copy.json: a.z has vi and no en"]);
  });

  it("takes a key written in English only", () => {
    expect(strayWords({ "features/a/copy.json": { en: { "a.x": "Close" } } })).toEqual([]);
    expect(strayWords({ "features/a/copy.json": { en: { "a.x": "Close", "a.y": "Open" }, vi: { "a.x": "Dong" } } })).toEqual([]);
  });

  it("refuses a key two copy files hold, naming both", () => {
    const planted = { "features/a/copy.json": { en: { "a.x": "A" } }, "features/b/copy.json": { en: { "a.x": "B" } } };
    expect(() => composeCopy(planted)).toThrow('Product copy key "a.x" (en) is in both features/a/copy.json and features/b/copy.json');
    expect(composeCopy({ "features/a/copy.json": { en: { "a.x": "A" }, vi: { "a.x": "A vi" } } })).toEqual({ en: { "a.x": "A" }, vi: { "a.x": "A vi" } });
  });

  it("keeps the retired product-copy.json out of the tree, naming each of its keys' home if it comes back", () => {
    const found = existsSync(RETIRED) ? splitCheck(RETIRED) : null;
    expect(found?.stderr ?? null, "src/lib/i18n/product-copy.json is retired").toBeNull();
  });

  it("names the copy file an edited key of a re-added product-copy.json belongs in", () => {
    const dir = mkdtempSync(join(tmpdir(), "product-copy-"));
    try {
      const old = join(dir, "product-copy.json");
      writeFileSync(old, JSON.stringify({ en: { "issues.brandNew": "Brand new", "settings.project.brandNew": "New" }, vi: { "issues.brandNew": "Moi" } }));
      const run = splitCheck(old);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("is retired");
      expect(run.stderr).toContain("en issues.brandNew → src/features/issues/copy.json (new)");
      expect(run.stderr).toContain("en settings.project.brandNew → src/features/project-settings/copy.json (new)");
      expect(run.stderr).toContain("vi issues.brandNew → src/features/issues/copy.json (new)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
