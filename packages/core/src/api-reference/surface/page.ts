import { sentence } from '../declare/prose.js';
import type { OpenApiDocument } from '../document/build.js';
import { type Flow, operationOfStep, toMermaid } from './flows.js';

/** Third-party renderers, loaded from a CDN at an exact version with the hash of the file read. */
export const SCALAR = {
  src: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.71.0/dist/browser/standalone.js',
  integrity: 'sha384-I7aSmSxf06vl5HT10vzNOAryO+PFCAVHIGwhZerHn6yM/O0642381S3kw9o7fFQd',
} as const;

export const MERMAID = {
  src: 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.min.js',
  integrity: 'sha384-8xUhuLNMjW/cI2Dacg3DR4WliYznvIg0LVG1stctThKD/YVrJFI9TNCFxft5NYgp',
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
main { max-width: 80rem; margin: 0 auto; padding: 2rem 16px 4rem; }
main > h1, main > p, section > h2, section > p, section > ol, .scroll-hint { max-width: 56rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2.5rem 0 .25rem; }
p, li { color: var(--muted); }
a { color: var(--accent); }
section { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: .5rem; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
pre.mermaid {
  overflow-x: auto; max-width: 100%; padding: 1rem 0; margin: 0;
  background:
    linear-gradient(to right, var(--bg) 30%, transparent) left / 40px 100% no-repeat local,
    linear-gradient(to left, var(--bg) 30%, transparent) right / 40px 100% no-repeat local,
    linear-gradient(to right, var(--line), transparent) left / 16px 100% no-repeat scroll,
    linear-gradient(to left, var(--line), transparent) right / 16px 100% no-repeat scroll;
}
.scroll-hint { margin: 0 0 .5rem; font-size: .85rem; }
ol { padding-left: 1.2rem; }
`;

const REFERENCE_CONFIGURATION = {
  hideClientButton: true,
  defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
  // The viewer keeps its response codes in one row that scrolls inside a header it clips, so on a
  // narrow screen the last codes are out of sight; here they wrap into the row below instead.
  customCss:
    '.response-card .scalar-card-header-title { overflow: visible; white-space: normal; flex: 1 1 100%; } ' +
    '.response-card .tab-list { flex-wrap: wrap; overflow: visible; height: auto; }',
} as const;

/** The page that renders the served document, readable with no credential. */
export function renderReferencePage(openApiUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge core API reference</title>
<link rel="icon" href="data:,">
</head>
<body>
<script id="api-reference" data-url="${escapeHtml(openApiUrl)}" data-configuration="${escapeHtml(JSON.stringify(REFERENCE_CONFIGURATION))}"></script>
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
          const prose = [typeof op?.summary === 'string' ? op.summary : '', step.note]
            .map(sentence)
            .filter(Boolean)
            .join(' ');
          return `<li><code>${escapeHtml(step.call)}</code> — ${escapeHtml(prose)}</li>`;
        })
        .join('\n');
      return `<section id="${escapeHtml(flow.id)}">
<h2>${escapeHtml(flow.title)}</h2>
<p>${escapeHtml(flow.summary)}</p>
<pre class="mermaid" tabindex="0" aria-label="${escapeHtml(flow.title)} diagram">${escapeHtml(toMermaid(flow))}</pre>
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
<link rel="icon" href="data:,">
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
    startOnLoad: false,
    layout: 'dagre',
    look: 'classic',
    sequence: { useMaxWidth: false },
    flowchart: { useMaxWidth: false },
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
  });
  const frames = [...document.querySelectorAll('pre.mermaid')];
  const hints = frames.map((frame) => {
    const hint = document.createElement('p');
    hint.className = 'scroll-hint';
    hint.hidden = true;
    hint.textContent = 'This diagram is wider than the screen: scroll it sideways.';
    frame.before(hint);
    return hint;
  });
  const showWhereWider = () =>
    frames.forEach((frame, i) => { hints[i].hidden = frame.scrollWidth <= frame.clientWidth; });
  mermaid.run().then(() => {
    showWhereWider();
    new ResizeObserver(showWhereWider).observe(document.body);
  });
</script>
</body>
</html>
`;
}
