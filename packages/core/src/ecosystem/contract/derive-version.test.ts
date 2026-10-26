import { describe, expect, it } from 'vitest';
import { deriveVersion, UNNUMBERED } from './derive-version.js';
import type { MeasuredChange, MeasuredDiff } from './diff.js';

const tool = (name: string, description = `${name} does one thing`, props = {}) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: props },
});
const doc = (...tools: ReturnType<typeof tool>[]) =>
  JSON.stringify({ contract: 'forge-mcp', version: UNNUMBERED, tools });

const base = doc(tool('a'), tool('b'));
const mcp = (next: string, version: string | null = '1.4.2') =>
  deriveVersion({ type: 'mcp-tools', base: { version, text: base }, next });

const fixed = (diff: MeasuredDiff) => async () => diff;
const warned: MeasuredChange = {
  element: 'GET /a',
  kind: 'changed',
  level: 'warning',
  text: 'the x-forge-auth extension was changed',
  check: 'forge-extension-changed',
};
const unloadable: MeasuredChange = {
  element: 'document',
  kind: 'changed',
  level: 'warning',
  text: 'oasdiff could not compare the two versions: failed to load base spec',
  check: 'openapi-not-measured',
};

describe('the number a generated contract takes', () => {
  it('stays where the base left it when the contract did not move', async () => {
    expect(await mcp(base)).toEqual({ ok: true, version: '1.4.2', why: 'unchanged' });
  });

  it('is 1.0.0 after a base that was never numbered, or that held no number at all', async () => {
    const moved = doc(tool('a'));
    expect(await mcp(moved, UNNUMBERED)).toMatchObject({ ok: true, version: '1.0.0' });
    expect(await mcp(moved, null)).toMatchObject({ ok: true, version: '1.0.0' });
  });

  it('takes a MINOR for an addition, measured by the differ an upload is measured by', async () => {
    expect(await mcp(doc(tool('a'), tool('b'), tool('c')))).toMatchObject({
      ok: true,
      version: '1.5.0',
      why: expect.stringContaining('measured non-breaking after 1.4.2'),
    });
  });

  it('takes a MAJOR for a removal', async () => {
    expect(await mcp(doc(tool('a')))).toMatchObject({
      ok: true,
      version: '2.0.0',
      why: expect.stringContaining('tool b was removed'),
    });
  });

  it('takes a PATCH for a change that adds and removes nothing', async () => {
    expect(await mcp(doc(tool('a', 'a does it better'), tool('b')))).toMatchObject({
      ok: true,
      version: '1.4.3',
    });
  });

  it('takes a MAJOR for a change measured unknown, where the upload rule leaves the number to its uploader', async () => {
    const out = await deriveVersion(
      { type: 'openapi', base: { version: '3.2.1', text: '{"a":1}' }, next: '{"a":2}' },
      fixed({ tool: 'oasdiff', classification: 'unknown', changes: [warned] }),
    );
    expect(out).toMatchObject({ ok: true, version: '4.0.0' });
    expect(out.ok && out.why).toContain('x-forge-auth');
  });

  it('is refused, naming why, for a change no differ measured', async () => {
    const out = await deriveVersion(
      { type: 'openapi', base: { version: '3.2.1', text: '{"a":1}' }, next: '{"a":2}' },
      fixed({ tool: 'oasdiff', classification: 'unknown', changes: [unloadable] }),
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toContain('failed to load base spec');
  });

  it('is refused after a base number outside MAJOR.MINOR.PATCH, and nothing is measured', async () => {
    let measured = false;
    const out = await deriveVersion(
      { type: 'openapi', base: { version: '2026-10-01', text: '{"a":1}' }, next: '{"a":2}' },
      async () => {
        measured = true;
        return { tool: 'oasdiff', classification: 'non-breaking', changes: [] };
      },
    );
    expect(out).toMatchObject({ ok: false, refusal: expect.stringContaining('"2026-10-01"') });
    expect(measured).toBe(false);
  });
});
