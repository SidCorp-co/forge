/**
 * The flow diagrams, laid out by the mermaid the page loads (the same version, from this package's
 * own dependency) in a real Chrome. Each message label is measured against each lifeline: a label
 * is crossed where a lifeline runs through the box the label is drawn in.
 *
 * @gate-input whole-tree
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeOperation, json } from '../declare/describe.js';
import { buildReference } from '../document/build.js';
import { FLOWS, type Flow, toMermaid } from './flows.js';
import { MERMAID, renderFlowsPage } from './page.js';

const CHROMES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function chrome(): string {
  const named = process.env.CHROME_BIN;
  if (named && !existsSync(named))
    throw new Error(`CHROME_BIN names ${named}, which is not a file`);
  const found = named || CHROMES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `No Chrome to lay the diagrams out in: looked for ${CHROMES.join(', ')} and CHROME_BIN. A layout test that cannot run is not a pass.`,
    );
  }
  return found;
}

const mermaidFile = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');

/** Run inside the page once every diagram is drawn: the labels each lifeline runs through. */
const MEASURE = `
const done = () => [...document.querySelectorAll('pre.mermaid')].every((pre) => pre.querySelector('svg'));
const measure = () => {
  const crossings = [];
  const wider = [];
  let diagrams = 0;
  let labels = 0;
  for (const svg of document.querySelectorAll('pre.mermaid svg')) {
    diagrams += 1;
    const frame = svg.closest('pre.mermaid');
    if (frame.scrollWidth > frame.clientWidth) wider.push(frame.getAttribute('aria-label') + ' ' + frame.scrollWidth + '/' + frame.clientWidth);
    const lines = [...svg.querySelectorAll('line.actor-line')].map((l) => l.getBoundingClientRect());
    for (const text of svg.querySelectorAll('text.messageText')) {
      labels += 1;
      const box = text.getBoundingClientRect();
      for (const line of lines) {
        if (line.left > box.left + 1 && line.left < box.right - 1 && box.top < line.bottom && box.bottom > line.top) {
          crossings.push(text.textContent + ' | lifeline at x=' + Math.round(line.left));
        }
      }
    }
  }
  const out = document.createElement('pre');
  out.id = 'layout-result';
  out.textContent = JSON.stringify({ diagrams, labels, crossings, wider });
  document.body.append(out);
};
const wait = () => (done() ? measure() : setTimeout(wait, 100));
window.addEventListener('load', () => setTimeout(wait, 100));
`;

type Layout = { diagrams: number; labels: number; crossings: string[]; wider: string[] };

async function layoutIn(html: string, width: number): Promise<Layout> {
  const dir = mkdtempSync(join(tmpdir(), 'flows-layout-'));
  try {
    const page = html
      .replace(
        /<script src="[^"]*mermaid[^"]*"[^>]*><\/script>/,
        `<script src="${pathToFileURL(mermaidFile).href}"></script>`,
      )
      .replace('</body>', `<script>${MEASURE}</script></body>`);
    writeFileSync(join(dir, 'page.html'), page);
    const { stdout } = await promisify(execFile)(
      chrome(),
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--allow-file-access-from-files',
        `--user-data-dir=${join(dir, 'profile')}`,
        `--window-size=${width},900`,
        '--virtual-time-budget=20000',
        '--dump-dom',
        pathToFileURL(join(dir, 'page.html')).href,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
    );
    const result = new JSDOM(stdout).window.document.querySelector('#layout-result')?.textContent;
    if (!result) throw new Error('Chrome drew no diagrams: the page printed no layout result');
    return JSON.parse(result) as Layout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function documentFor(flows: readonly Flow[]) {
  const app = new Hono();
  for (const flow of flows) {
    for (const step of flow.steps) {
      const [method, path] = step.call.split(' ');
      app.on(
        method ?? 'GET',
        path ?? '/',
        describeOperation({ summary: step.call, responses: { 200: json(z.object({})) } }),
        (c) => c.json({}),
      );
    }
  }
  return (await buildReference(app, { version: 't' })).document;
}

describe('the flow diagrams in Chrome', () => {
  it('loads the mermaid the page names, so the layout measured is the layout shipped', () => {
    const installed = createRequire(import.meta.url)('mermaid/package.json') as { version: string };
    expect(MERMAID.src).toContain(`mermaid@${installed.version}/`);
  });

  it.each([1280, 390])(
    'draws every flow with no lifeline through a message label, at %ipx',
    async (width) => {
      const document = await documentFor(FLOWS);
      const layout = await layoutIn(renderFlowsPage(FLOWS, document, '/api/reference'), width);
      expect(layout.diagrams).toBe(FLOWS.length);
      expect(layout.labels).toBeGreaterThanOrEqual(FLOWS.flatMap((f) => f.steps).length * 2);
      expect(layout.crossings).toEqual([]);
      // Where the screen is wide a diagram fits its column; where it is not, it scrolls in its own frame.
      if (width >= 1280) expect(layout.wider).toEqual([]);
    },
    120_000,
  );

  it('goes red on a diagram with core at the end and three lifelines, which draws a label across one', async () => {
    const flow: Flow = {
      id: 'planted',
      title: 'Planted',
      summary: 's',
      steps: [
        {
          from: 'Runner',
          call: 'POST /api/a',
          note: 'A note long enough to be drawn across the lifeline.',
        },
        { from: 'Person', call: 'POST /api/b', note: 'Another.' },
      ],
    };
    const document = await documentFor([flow]);
    const html = renderFlowsPage([flow], document, '/api/reference').replace(
      /(<pre class="mermaid"[^>]*>)[\s\S]*?(<\/pre>)/,
      `$1sequenceDiagram
  participant Runner
  participant Person
  participant Core
  Runner->>Core: 1. POST /api/a
  Core-->>Runner: A note long enough to be drawn across the lifeline.
  Person->>Core: 2. POST /api/b$2`,
    );
    const layout = await layoutIn(html, 1280);
    expect(layout.crossings.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('toMermaid', () => {
  it('seats core between the two actors, so every arrow joins neighbours', () => {
    const flow: Flow = {
      id: 'f',
      title: 'F',
      summary: 's',
      steps: [
        { from: 'Runner', call: 'POST /a', note: 'Ok.' },
        { from: 'Person', call: 'POST /b', note: 'Ok.' },
      ],
    };
    expect(toMermaid(flow).split('\n').slice(1, 4)).toEqual([
      '  participant Runner',
      '  participant Core',
      '  participant Person',
    ]);
  });

  it('refuses a flow of three actors by name, which no order of lifelines draws without a crossing', () => {
    const steps = (['Runner', 'Person', 'Agent'] as const).map((from) => ({
      from,
      call: 'GET /x',
      note: 'Ok.',
    }));
    expect(() => toMermaid({ id: 'three', title: 'T', summary: 's', steps })).toThrow(
      /flow three names 3 actors \(Runner, Person, Agent\)/,
    );
  });
});
