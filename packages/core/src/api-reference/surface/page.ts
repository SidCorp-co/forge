import type { OpenApiDocument } from '../document/build.js';
import { type Flow, operationOfStep, toMermaid } from './flows.js';

/** Third-party renderers, loaded from a CDN at an exact version with the hash of the file read. */
export const SCALAR = {
  src: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.71.0/dist/browser/standalone.js',
  integrity: 'sha384-I7aSmSxf06vl5HT10vzNOAryO+PFCAVHIGwhZerHn6yM/O0642381S3kw9o7fFQd',
} as const;

export const MERMAID = {
  src: 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js',
  integrity: 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2',
} as const;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const STYLE = `
:root { --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6860; --line: #e2dfd8; --accent: #8a5a1f; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #161513; --fg: #ece9e2; --muted: #9b978d; --line: #2d2b27; --accent: #d9a35a; }
}
:root[data-theme="dark"] { --bg: #161513; --fg: #ece9e2; --muted: #9b978d; --line: #2d2b27; --accent: #d9a35a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 Inter, system-ui, sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 2rem 16px 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2.5rem 0 .25rem; }
p, li { color: var(--muted); }
a { color: var(--accent); }
section { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: .5rem; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
pre.mermaid { overflow-x: auto; padding: 1rem 0; }
ol { padding-left: 1.2rem; }
`;

/** The page that renders the served document, readable with no credential. */
export function renderReferencePage(openApiUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge core API reference</title>
</head>
<body>
<script id="api-reference" data-url="${escapeHtml(openApiUrl)}" data-configuration='{"hideClientButton":true,"defaultHttpClient":{"targetKey":"shell","clientKey":"curl"}}'></script>
<script src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous"></script>
</body>
</html>
`;
}

/** The flows as diagrams, each step linked to nothing it cannot name: a step is checked against the document. */
export function renderFlowsPage(
  flows: readonly Flow[],
  document: OpenApiDocument,
  referenceUrl: string,
): string {
  const sections = flows
    .map((flow) => {
      const steps = flow.steps
        .map((step) => {
          const op = operationOfStep(document, step.call);
          const summary = typeof op?.summary === 'string' ? ` — ${escapeHtml(op.summary)}` : '';
          return `<li><code>${escapeHtml(step.call)}</code>${summary}. ${escapeHtml(step.note)}</li>`;
        })
        .join('\n');
      return `<section id="${escapeHtml(flow.id)}">
<h2>${escapeHtml(flow.title)}</h2>
<p>${escapeHtml(flow.summary)}</p>
<pre class="mermaid">${escapeHtml(toMermaid(flow))}</pre>
<ol>
${steps}
</ol>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge core API flows</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Forge core API flows</h1>
<p>The order of calls for the flows an agent drives. Every call is an operation in the <a href="${escapeHtml(referenceUrl)}">API reference</a>.</p>
${sections}
</main>
<script src="${MERMAID.src}" integrity="${MERMAID.integrity}" crossorigin="anonymous"></script>
<script>
  mermaid.initialize({
    startOnLoad: true,
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
  });
</script>
</body>
</html>
`;
}
