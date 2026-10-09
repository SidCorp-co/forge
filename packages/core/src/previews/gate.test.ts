// The gate's script (./gate.ts) run against a stand-in page: what it does in a tab, in a frame, when
// the browser grants or refuses storage access, and when a re-entry did not help. The browser half of
// the proof is the real Chromium and WebKit run recorded with the lane; this holds the rules.

import { createContext, runInContext } from 'node:vm';
import { PREVIEW_FRAME_MESSAGES as M, PREVIEW_ENTER_PATH } from '@forge/contracts/preview';
import { describe, expect, it } from 'vitest';
import { gateCsp, gateScript } from './gate.js';

const APP = 'https://forge.example.test';
const HOST = 'https://p-aaaaaaaaaaaaaaaa.preview.example.test';

interface Opts {
  framed?: boolean;
  access?: 'grant' | 'refuse' | 'unsupported';
  alreadyHas?: boolean;
  marked?: boolean;
  storage?: 'ok' | 'throws';
}

function run(opts: Opts = {}) {
  const posted: { message: Record<string, unknown>; target: string }[] = [];
  const replaced: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const nodes = new Map<string, Record<string, unknown>>();
  const node = (id: string) => {
    if (!nodes.has(id))
      nodes.set(id, { hidden: false, disabled: false, textContent: '', onclick: null });
    return nodes.get(id) as Record<string, unknown> & {
      onclick: (() => void) | null;
      hidden: boolean;
      disabled: boolean;
      textContent: string;
    };
  };
  const parent = {
    postMessage: (message: Record<string, unknown>, target: string) =>
      posted.push({ message, target }),
  };
  const store = new Map<string, string>(
    opts.marked ? [['forge.previewReentry', String(Date.now())]] : [],
  );
  const window: Record<string, unknown> = {
    name: '',
    parent,
    addEventListener: (name: string, fn: (e: unknown) => void) => {
      listeners[name] = fn;
    },
    sessionStorage:
      opts.storage === 'throws'
        ? {
            getItem: () => {
              throw new Error('blocked');
            },
            setItem: () => {
              throw new Error('blocked');
            },
          }
        : {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
          },
  };
  window.self = window;
  window.top = opts.framed === false ? window : { other: true };
  const document: Record<string, unknown> = { getElementById: node };
  if (opts.access !== 'unsupported') {
    document.requestStorageAccess = () =>
      opts.access === 'refuse' ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
    document.hasStorageAccess = () => Promise.resolve(opts.alreadyHas === true);
  }
  const ctx = createContext({
    window,
    document,
    parent,
    URL,
    Promise,
    setTimeout: () => 0,
    Date,
    Number,
    String,
    location: { origin: HOST, replace: (u: string) => replaced.push(u) },
  });
  Object.assign(ctx, { sessionStorage: window.sessionStorage });
  runInContext(gateScript(APP), ctx);
  const settle = () => new Promise((r) => setImmediate(r));
  const fromParent = (data: unknown, origin = APP, source: unknown = parent) =>
    listeners.message?.({ origin, source, data });
  return { posted, replaced, node, settle, fromParent, click: () => node('allow').onclick?.() };
}

const enterUrl = `${HOST}${PREVIEW_ENTER_PATH}?ticket=fresh`;

describe('the gate script', () => {
  it('does nothing in a tab of its own: the page keeps saying where to open the preview from', () => {
    const g = run({ framed: false });
    expect(g.node('top').hidden).toBe(false);
    expect(g.node('framed').hidden).toBe(false);
    expect(g.posted).toEqual([]);
  });

  it('shows Allow in a frame and asks nothing until the person clicks', async () => {
    const g = run();
    expect(g.node('top').hidden).toBe(true);
    expect(g.node('framed').hidden).toBe(false);
    await g.settle();
    expect(g.posted).toEqual([]);
  });

  it('on a click asks the browser, then asks Forge for a fresh ticket, and enters with what Forge sends', async () => {
    const g = run();
    g.click();
    await g.settle();
    expect(g.posted).toEqual([{ message: { type: M.ticketRequest }, target: APP }]);
    g.fromParent({ type: M.ticket, url: enterUrl });
    expect(g.replaced).toEqual([enterUrl]);
  });

  it('takes a ticket from nobody but its parent, at Forge origin, naming its own enter path', async () => {
    const g = run();
    g.click();
    await g.settle();
    g.fromParent({ type: M.ticket, url: enterUrl }, 'https://evil.example.test');
    g.fromParent({ type: M.ticket, url: enterUrl }, APP, {});
    g.fromParent({
      type: M.ticket,
      url: `https://evil.example.test${PREVIEW_ENTER_PATH}?ticket=x`,
    });
    g.fromParent({ type: M.ticket, url: `${HOST}/anything-else` });
    g.fromParent({ type: M.ticket, url: 'not a url' });
    g.fromParent({ type: 'other', url: enterUrl });
    g.fromParent(null);
    expect(g.replaced).toEqual([]);
  });

  it('says so, tells Forge, and does not ask for a ticket when the browser refuses storage access', async () => {
    const g = run({ access: 'refuse' });
    g.click();
    await g.settle();
    expect(g.posted).toEqual([{ message: { type: M.storageRefused }, target: APP }]);
    expect(g.node('msg').textContent).toContain('did not allow');
    expect(g.node('allow').hidden).toBe(true);
    expect(g.replaced).toEqual([]);
  });

  it('asks for a ticket by itself where access is already held, once, and not again after a re-entry', async () => {
    const held = run({ alreadyHas: true });
    await held.settle();
    expect(held.posted).toEqual([{ message: { type: M.ticketRequest }, target: APP }]);

    const again = run({ alreadyHas: true, marked: true });
    await again.settle();
    expect(again.posted).toEqual([{ message: { type: M.storageRefused }, target: APP }]);
    expect(again.node('msg').textContent).toContain('still cannot keep its cookie');
    expect(again.node('allow').hidden).toBe(true);
  });

  it('stops after one re-entry where the frame lets nothing be stored, by the frame name', async () => {
    const first = run({ storage: 'throws' });
    first.click();
    await first.settle();
    expect(first.posted.map((p) => p.message.type)).toEqual([M.ticketRequest]);
  });

  it('goes on where the browser has no Storage Access API: the re-entry shows whether the cookie is kept', async () => {
    const g = run({ access: 'unsupported' });
    g.click();
    await g.settle();
    expect(g.posted).toEqual([{ message: { type: M.ticketRequest }, target: APP }]);
  });
});

describe('the gate CSP', () => {
  it('names the script by hash and lets only Forge frame it', () => {
    const script = gateScript(APP);
    const csp = gateCsp(script, APP);
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain(`frame-ancestors ${APP}`);
    expect(csp).toContain("default-src 'none'");
    expect(gateCsp(`${script} `, APP)).not.toBe(csp);
  });
});
