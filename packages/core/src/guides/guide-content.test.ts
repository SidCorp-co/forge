/**
 * ISS-1174 — a guide body is a markdown file embedded at build. What would let a page reach an
 * agent wrong is a body with no guide, a guide with no body, a `{{NAME}}` nobody filled, or an
 * embedded module that no longer matches its folder; each is planted here and refused by name.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GUIDE_CONTENT } from './content.generated.js';
import { guideBody, guideContentSlugs } from './guide-content.js';
import { FORGE_GUIDES } from './registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..', '..');
const SCRIPT = join(CORE, 'scripts', 'gen-guide-content.mjs');
const CONTENT_DIR = join(HERE, 'content');

describe('guideBody', () => {
  const content = { plain: 'no placeholder\n', filled: 'a {{ONE}} and {{ONE}} and {{TWO}}\n' };

  it('returns a body with no placeholder exactly as the file holds it', () => {
    expect(guideBody('plain', {}, content)).toBe('no placeholder\n');
  });

  it('puts each value where its name stands, and reads a value literally', () => {
    expect(guideBody('filled', { ONE: '$& `x`', TWO: '2' }, content)).toBe(
      'a $& `x` and $& `x` and 2\n',
    );
  });

  it('refuses a slug with no body file, naming the file it expected', () => {
    expect(() => guideBody('no-such', {}, content)).toThrow(
      "guide 'no-such' has no body: expected packages/core/src/guides/content/no-such.md",
    );
  });

  it('refuses a placeholder the code supplies no value for, naming it', () => {
    expect(() => guideBody('filled', { ONE: '1' }, content)).toThrow(
      "guide 'filled' holds {{TWO}} and the code supplies no value for it",
    );
  });

  it('refuses a value whose name the body never uses, naming it', () => {
    expect(() => guideBody('plain', { STRAY: 'x' }, content)).toThrow(
      "guide 'plain' is given STRAY and its body has no {{STRAY}} to put it in",
    );
  });
});

describe('the guides core serves, against the folder that holds their bodies', () => {
  it('has a body file for every slug the folder holds, and a guide for each', () => {
    const slugs = new Set(FORGE_GUIDES.map((g) => g.slug));
    const orphans = guideContentSlugs().filter((s) => !slugs.has(s));
    expect(orphans, `body files naming no guide: ${orphans.join(', ')}`).toEqual([]);
  });

  it('embeds exactly the files in the folder', () => {
    const files = readdirSync(CONTENT_DIR)
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(Object.keys(GUIDE_CONTENT).sort()).toEqual(files);
  });

  it('serves no body with a {{NAME}} left in it', () => {
    const left = FORGE_GUIDES.filter((g) => /\{\{[A-Za-z0-9_]+\}\}/.test(g.body)).map(
      (g) => g.slug,
    );
    expect(left).toEqual([]);
  });

  it('carries an embedded module that is current with the folder', () => {
    expect(() => execFileSync('node', [SCRIPT, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('the generator, against planted files', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function run(files: Record<string, string>, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'gen-guide-'));
    made.push(dir);
    const from = join(dir, 'content');
    mkdirSync(from);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(from, name), text);
    const to = join(dir, 'out.generated.ts');
    const r = spawnSync('node', [SCRIPT, '--from', from, '--to', to, ...extra], {
      encoding: 'utf8',
    });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  }

  it('writes a well-formed folder', () => {
    expect(run({ 'a-guide.md': '## A\n' }).status).toBe(0);
  });

  it('refuses a file that is not <slug>.md, naming it', () => {
    const r = run({ 'notes.txt': 'x\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('notes.txt: only <slug>.md files belong in this folder');
  });

  it('refuses a name that is not a slug, naming it', () => {
    const r = run({ 'Bad_Name.md': 'x\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"Bad_Name" is not a slug');
  });

  it('refuses an empty body, naming the file', () => {
    const r = run({ 'empty.md': '\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('empty.md: the body is empty');
  });

  it('refuses a carriage return, naming the file', () => {
    const r = run({ 'crlf.md': 'a\r\nb\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('crlf.md: carries a carriage return');
  });

  it('refuses, with --check, an embedded module that differs from the folder', () => {
    const r = run({ 'a-guide.md': '## A\n' }, ['--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not match src/guides/content/');
  });
});
