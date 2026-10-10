#!/usr/bin/env node
// The UI sweep's worklist: every ESLint violation in web-v2 (frozen or not), counted per rule and
// per feature, as markdown. Reads ESLint's JSON report from stdin or a file argument.
//   eslint -f json --suppressions-location /dev/null src | node scripts/lint-inventory.mjs
//   node scripts/lint-inventory.mjs report.json > inventory.md

import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2] ?? 0, "utf8");
const report = JSON.parse(raw);

const area = (path) => {
  const rel = path.slice(path.indexOf("/src/") + 5);
  // tests are linted but out of the sweep (no test is edited by it)
  if (/\.test\.tsx?$/.test(rel) || rel.startsWith("test/")) return "(tests)";
  const f = /^features\/([^/]+)\//.exec(rel);
  if (f) return `features/${f[1]}`;
  return rel.split("/")[0];
};

const byRule = new Map();
const byArea = new Map();
const cell = new Map();
let total = 0;
for (const file of report) {
  const a = area(file.filePath);
  for (const m of file.messages) {
    const rule = m.ruleId ?? "(parse)";
    total += 1;
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    byArea.set(a, (byArea.get(a) ?? 0) + 1);
    const k = `${a}\t${rule}`;
    cell.set(k, (cell.get(k) ?? 0) + 1);
  }
}

const sorted = (m) => [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
const out = [];
out.push(`# web-v2 lint inventory`, "", `${total} violations in ${report.filter((f) => f.messages.length).length} files.`, "");
out.push("## Per rule", "", "| Rule | Count |", "|---|---:|");
for (const [r, n] of sorted(byRule)) out.push(`| \`${r}\` | ${n} |`);
out.push("", "## Per feature (and other src areas)", "", "| Area | Count | Top rules |", "|---|---:|---|");
for (const [a, n] of sorted(byArea)) {
  const top = sorted(new Map([...cell].filter(([k]) => k.startsWith(`${a}\t`)).map(([k, v]) => [k.split("\t")[1], v])))
    .slice(0, 4)
    .map(([r, v]) => `${r.replace(/^@typescript-eslint\//, "ts/")} ${v}`)
    .join(" · ");
  out.push(`| ${a} | ${n} | ${top} |`);
}
console.log(out.join("\n"));
