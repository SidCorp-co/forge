#!/usr/bin/env node
// cm:edge contract -> docs/flows/index.html — this script owns that file's map half; only the block between the RULES markers is hand-written, and a map edited by hand rots the way docs/system.graph.json did (5 months, 2 of 9 modules missing)
// cm:guard the data is INLINED, never fetched — the folder must open from disk and `fetch()` is refused on a file:// origin, so a sibling .json leaves the map blank locally
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const flowsDir = join(root, 'docs/flows');
const check = process.argv.includes('--check');

const graph = JSON.parse(readFileSync(join(root, 'docs/system.graph.json'), 'utf8'));
const graphModules = new Set(graph.nodes.filter((n) => n.kind === 'module').map((n) => n.id));
const contains = graph.edges.filter((e) => e.relation === 'contains');
const parentOf = new Map(contains.map((e) => [e.to, e.from]));

const meta = (src, name) =>
  src.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1] ?? '';
const unesc = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const TEMPLATE = `<!doctype html>
<meta charset="utf-8">
<title>Forge flow map</title>
<style>
  :root { --fg:#1c1a17; --mut:#6b645c; --faint:#9a9288; --line:#ddd7cf; --bg:#fbfaf8; --panel:#fff;
          --acc:#1f6f4a; --accbg:#e6efe9; --bad:#8a3b52; --warn:#9a6b1f; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14.5px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  code { font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace; background:#f0ece6; padding:.1em .35em; border-radius:3px }
  .bar { display:flex; align-items:center; gap:.5rem; padding:.75rem 1.3rem; background:var(--panel);
         border-bottom:1px solid var(--line); font:12.5px ui-monospace,Menlo,monospace }
  .bar a { color:var(--acc); text-decoration:none } .bar a:hover { text-decoration:underline }
  .bar .sep { color:var(--faint) } .bar .now { font-weight:700 }
  .bar .hint { margin-left:auto; color:var(--faint); font-family:ui-sans-serif,system-ui,sans-serif }
  #canvas { padding:1.5rem 1.3rem; overflow-x:auto }
  .mermaid svg { max-width:none !important; height:auto }
  .node.clickable { cursor:pointer }
  .node.clickable:hover rect, .node.clickable:hover polygon { filter:brightness(.94) }
  details { border-top:1px solid var(--line); background:var(--panel) }
  summary { padding:.75rem 1.3rem; cursor:pointer; font:600 12.5px ui-sans-serif,system-ui,sans-serif; color:var(--mut) }
  .rules { padding:0 1.3rem 1.6rem; max-width:62rem }
  .rules ul { padding-left:1.1rem; font-size:13.5px } .rules li { margin:.35rem 0 }
  .rule { background:var(--bg); border:1px solid var(--line); border-left:3px solid var(--acc);
          padding:.9rem 1.1rem; border-radius:4px }
  .warn { color:var(--bad); font-weight:600 }
</style>

<div class="bar" id="crumb"></div>
<div id="canvas"><pre class="mermaid" id="fig"></pre></div>

<details>
  <summary>Rules — how a flow in this folder is drawn</summary>
  <div class="rules">
<!--RULES-->
  </div>
</details>

<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
const DATA = /*DATA*/;
const esc = s => String(s).replace(/"/g, '&quot;');
const nid = s => 'N' + s.replace(/[^A-Za-z0-9]/g, '');
// a flow's own name already carries its module; the map shows the part that differs
const trim = (n, mod) => n.replace(new RegExp('^' + mod.replace(/[^a-z0-9-]/g, '') + '-?'), '') || n;

function overview() {
  const mods = Object.entries(DATA.modules);
  let s = 'flowchart LR\\n';
  s += '  classDef svc fill:#e6efe9,stroke:#1f6f4a,stroke-width:2px,color:#14532d\\n';
  s += '  classDef mod fill:#fff,stroke:#ddd7cf\\n';
  s += '  classDef gap fill:#f6ecef,stroke:#8a3b52\\n';
  const parents = [...new Set(mods.map(([, v]) => v.parent))];
  for (const p of parents) s += \`  \${nid(p)}["\${esc(p)}"]:::svc\\n\`;
  for (const [id, v] of mods) {
    const n = v.flows.length, gaps = v.flows.filter(f => f.figures === 0).length;
    s += \`  \${nid(v.parent)} --> \${nid(id)}["\${esc(id)}<br/>\${n} flow"]:::\${gaps ? 'gap' : 'mod'}\\n\`;
    s += \`  click \${nid(id)} "#/m/\${encodeURIComponent(id)}"\\n\`;
  }
  return s;
}

function module(id) {
  const v = DATA.modules[id];
  let s = 'flowchart LR\\n';
  s += '  classDef hub fill:#e6efe9,stroke:#1f6f4a,stroke-width:2px,color:#14532d\\n';
  s += '  classDef f fill:#fff,stroke:#ddd7cf\\n';
  s += '  classDef gap fill:#f6ecef,stroke:#8a3b52\\n';
  s += \`  H(["\${esc(id)}"]):::hub\\n\`;
  v.flows.forEach((f, i) => {
    s += \`  H --> F\${i}["\${esc(trim(f.file.replace(/\\.html$/, ''), id))}"]:::\${f.figures ? 'f' : 'gap'}\\n\`;
    s += \`  click F\${i} "\${esc(f.file)}"\\n\`;
  });
  return s;
}

function render() {
  const m = location.hash.match(/^#\\/m\\/(.+)$/);
  const id = m && DATA.modules[decodeURIComponent(m[1])] ? decodeURIComponent(m[1]) : null;
  const bar = document.getElementById('crumb');
  bar.innerHTML = id
    ? \`<a href="#/">forge</a><span class="sep">/</span><span class="now">\${esc(id)}</span>\`
      + \`<span class="hint">\${esc(DATA.modules[id].purpose)}</span>\`
    : \`<span class="now">forge</span><span class="hint">click a module &mdash; red means a flow in it draws nothing</span>\`;
  const fig = document.getElementById('fig');
  fig.removeAttribute('data-processed');
  fig.textContent = id ? module(id) : overview();
  mermaid.run({ nodes: [fig] }).catch(() => {}).finally(() => {
    const svg = fig.querySelector('svg');
    if (!svg) return;
    const vb = (svg.getAttribute('viewBox') || '').split(/\\s+/);
    if (vb.length === 4) { svg.style.width = vb[2] + 'px'; svg.style.maxWidth = 'none'; }
  });
}

mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'neutral',
  themeVariables: { fontSize: '12px', fontFamily: 'ui-sans-serif,system-ui,sans-serif' },
  flowchart: { useMaxWidth: false, nodeSpacing: 26, rankSpacing: 52, padding: 6 } });
addEventListener('hashchange', render);
render();
</script>
`;

const problems = [];
const flows = [];
for (const file of readdirSync(flowsDir)
  .filter((f) => f.endsWith('.html') && f !== 'index.html')
  .sort()) {
  const src = readFileSync(join(flowsDir, file), 'utf8');
  const module = meta(src, 'flow-module');
  const answers = unesc(meta(src, 'flow-answers'));
  if (!module) {
    problems.push(`${file}: no <meta name="flow-module">`);
    continue;
  }
  if (!graphModules.has(module)) {
    problems.push(`${file}: module "${module}" is not a module node in docs/system.graph.json`);
    continue;
  }
  const figures =
    (src.match(/<pre class="mermaid"/g) ?? []).length + (src.match(/<svg\b/g) ?? []).length;
  if (figures === 0)
    problems.push(
      `${file}: declares no figure — a flow file that shows no mechanism has not earned its file`,
    );
  const body = src.replace(/<(style|script|svg)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
  flows.push({
    file,
    module,
    answers,
    figures,
    words: (body.match(/[A-Za-z][A-Za-z-]+/g) ?? []).length,
  });
}

const byModule = {};
for (const f of flows) {
  byModule[f.module] ??= [];
  byModule[f.module].push(f);
}
for (const id of graphModules)
  if (!byModule[id])
    problems.push(`module "${id}" is in the graph and has no flow — draw one or drop the node`);

if (problems.length) {
  console.error(`flow-map:\n  ${problems.join('\n  ')}`);
  if (check) process.exit(1);
}

const data = {
  modules: Object.fromEntries(
    Object.entries(byModule).map(([id, fs]) => [
      id,
      {
        parent: parentOf.get(id) ?? 'forge',
        purpose: graph.nodes.find((n) => n.id === id)?.purpose ?? '',
        flows: fs.sort((a, b) => b.words - a.words),
      },
    ]),
  ),
};

const page = readFileSync(join(flowsDir, 'index.html'), 'utf8');
const rules = page.match(/<!--RULES-->[\s\S]*?<!--\/RULES-->/)?.[0];
if (!rules) {
  console.error('flow-map: docs/flows/index.html has no <!--RULES--> block to preserve');
  process.exit(2);
}

const out = TEMPLATE.replace('/*DATA*/', JSON.stringify(data)).replace('<!--RULES-->', rules);

if (check) {
  if (readFileSync(join(flowsDir, 'index.html'), 'utf8') !== out) {
    console.error(
      'flow-map: docs/flows/index.html is stale — run `node scripts/build-flow-map.mjs`',
    );
    process.exit(1);
  }
  console.log(
    `flow-map: ${flows.length} flow(s) across ${Object.keys(byModule).length} module(s) · index up to date`,
  );
} else {
  writeFileSync(join(flowsDir, 'index.html'), out);
  console.log(
    `flow-map: wrote index.html — ${flows.length} flow(s), ${Object.keys(byModule).length} module(s)`,
  );
}
