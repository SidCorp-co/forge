#!/usr/bin/env node
// The words of a screen no fixture draws, estimated from its component's text: every product-copy
// key its files name (`t("x.y")`, `copy("x.y")`), looked up in English (src/lib/i18n/copy/*.json) and
// counted once, plus the literal text between JSX tags. It is the most the screen's own files can
// say, with every state's text in it, so it is an upper bound on a first view and says so: the
// audit marks it estimated and keeps no shot of it. `node witness/estimate-words.mjs` prints
// `{ route, words }` for each inventory entry that has `files`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY } from "./screens.inventory.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;
const words = (s) => (s.match(WORD) ?? []).length;

const en = {};
const dir = resolve(SRC, "lib/i18n/copy");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) Object.assign(en, JSON.parse(readFileSync(resolve(dir, f), "utf8")).en ?? {});

/** The files a screen's own files draw: what they import from their folder, or from the same feature, to a depth of two. */
function drawn(files) {
  const seen = new Set(files);
  let wave = [...files];
  // a route file's own text is all of it: what it imports (the auth shell, the whole of a feature) is not its page
  for (let depth = 0; depth < 2; depth++) {
    const next = [];
    for (const f of wave) {
      if (f.startsWith("routes/")) continue;
      const path = resolve(SRC, f);
      if (!existsSync(path)) continue;
      const feature = /^(features\/[^/]+)\//.exec(f)?.[1];
      for (const m of readFileSync(path, "utf8").matchAll(/from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g)) {
        const base = m[1].startsWith("@/") ? m[1].slice(2) : resolve(dirname(path), m[1]).slice(SRC.length + 1);
        if (feature && !base.startsWith(feature) && !base.startsWith("routes/")) continue;
        for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
          const hit = `${base}${ext}`;
          if (/\.test\./.test(hit) || !existsSync(resolve(SRC, hit)) || seen.has(hit)) continue;
          seen.add(hit);
          next.push(hit);
          break;
        }
      }
    }
    wave = next;
  }
  return [...seen];
}

export function estimate(own) {
  const files = drawn(own);
  const keys = new Set();
  let literal = 0;
  for (const f of files) {
    const path = resolve(SRC, f);
    if (!existsSync(path)) throw new Error(`${f} is not under src/: the inventory names a file that is gone`);
    const code = readFileSync(path, "utf8");
    for (const m of code.matchAll(/["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)["'`]/g)) if (m[1] in en) keys.add(m[1]);
    for (const m of code.matchAll(/>\s*([A-Za-z][^<>{}]{2,})\s*</g)) literal += words(m[1]);
  }
  return { words: [...keys].reduce((n, k) => n + words(en[k]), 0) + literal, keys: keys.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const s of INVENTORY.filter((s) => s.files)) console.log(JSON.stringify({ route: s.route, ...estimate(s.files) }));
}
