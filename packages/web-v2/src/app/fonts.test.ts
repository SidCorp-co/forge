import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(APP_DIR, "..");
const FONT_DIR = join(APP_DIR, "fonts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) ? [full] : [];
  });
}

describe("vendored fonts", () => {
  it("no source file fetches a font at build time", () => {
    const offenders = sourceFiles(SRC_DIR).filter((file) =>
      /from\s+["']next\/font\/google["']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => f.slice(SRC_DIR.length + 1))).toEqual([]);
  });

  it("layout declares both families from files that exist on disk", () => {
    const layout = readFileSync(join(APP_DIR, "layout.tsx"), "utf8");
    const declared = [...layout.matchAll(/src:\s*"\.\/fonts\/([^"]+)"/g)].map((m) => m[1]);

    expect(declared).toEqual([
      "hanken-grotesk-latin-variable.woff2",
      "jetbrains-mono-latin-variable.woff2",
    ]);
    for (const file of declared) expect(statSync(join(FONT_DIR, file)).size).toBeGreaterThan(1024);
  });

  it("ships a redistribution licence beside each binary", () => {
    const shipped = readdirSync(FONT_DIR);
    for (const licence of ["OFL-hanken-grotesk.txt", "OFL-jetbrains-mono.txt"]) {
      expect(shipped).toContain(licence);
      expect(readFileSync(join(FONT_DIR, licence), "utf8")).toContain(
        "SIL OPEN FONT LICENSE Version 1.1",
      );
    }
  });

  it("exposes the families through the variables :root resolves", () => {
    const layout = readFileSync(join(APP_DIR, "layout.tsx"), "utf8");
    expect(layout).toMatch(/variable:\s*"--font-hanken"/);
    expect(layout).toMatch(/variable:\s*"--font-jetbrains"/);
    expect(layout).toMatch(/<html[^>]*className=\{`\$\{hanken\.variable\} \$\{jetbrainsMono\.variable\}`\}/);
  });
});
