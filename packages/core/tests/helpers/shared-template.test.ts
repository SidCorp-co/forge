import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatMarker,
  HOLDER_OPTIONS,
  hashMigrations,
  parseMarker,
  resolveTemplateMode,
  SHARED_TEMPLATE,
  sharedTemplateName,
} from './shared-template.js';

const made: string[] = [];

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'shared-template-'));
  made.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const at = join(dir, rel);
    mkdirSync(join(at, '..'), { recursive: true });
    writeFileSync(at, body);
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JOURNAL = (tags: string[]) =>
  JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: tags.map((tag, idx) => ({
      idx,
      version: '7',
      when: 1000 + idx,
      tag,
      breakpoints: true,
    })),
  });

const BASE = {
  'meta/_journal.json': JOURNAL(['0000_a']),
  '0000_a.sql': 'CREATE TABLE a (x int);',
};

describe('hashMigrations', () => {
  it('names the same content the same, wherever it sits and whatever its mtime', () => {
    const one = folder(BASE);
    const two = folder(BASE);
    utimesSync(join(two, '0000_a.sql'), new Date(2001, 1, 1), new Date(2001, 1, 1));
    expect(hashMigrations(one)).toBe(hashMigrations(two));
  });

  it('names a journal that differs by one entry differently', () => {
    const more = folder({
      ...BASE,
      'meta/_journal.json': JOURNAL(['0000_a', '0001_b']),
      '0001_b.sql': 'CREATE TABLE b (x int);',
    });
    expect(hashMigrations(more)).not.toBe(hashMigrations(folder(BASE)));
  });

  it('names a journal whose only change is the entry list differently', () => {
    const renamed = folder({ ...BASE, 'meta/_journal.json': JOURNAL(['0000_z']) });
    expect(hashMigrations(renamed)).not.toBe(hashMigrations(folder(BASE)));
  });

  it('names a migration that differs by one byte differently', () => {
    const edited = folder({ ...BASE, '0000_a.sql': 'CREATE TABLE a (y int);' });
    expect(hashMigrations(edited)).not.toBe(hashMigrations(folder(BASE)));
  });

  it('does not let a byte move from one file into the next and read the same', () => {
    const left = folder({ 'a.sql': 'ab', 'b.sql': 'c' });
    const right = folder({ 'a.sql': 'a', 'b.sql': 'bc' });
    expect(hashMigrations(left)).not.toBe(hashMigrations(right));
  });

  it('refuses a folder that is not there, and one with nothing in it, by name', () => {
    expect(() => hashMigrations(join(tmpdir(), 'shared-template-absent-folder'))).toThrow(
      /does not exist/,
    );
    expect(() => hashMigrations(folder({}))).toThrow(/holds no files/);
  });

  it('names a template the reaper can tell from a run-stamped one', () => {
    expect(SHARED_TEMPLATE.test(sharedTemplateName(hashMigrations(folder(BASE))))).toBe(true);
    expect(SHARED_TEMPLATE.test('forge_test_tpl_mf3k2a9x_0a1b2c3d')).toBe(false);
  });
});

describe('resolveTemplateMode', () => {
  it('shares on a box with an instance and no CI', () => {
    expect(resolveTemplateMode({}, true).mode).toBe('shared');
  });

  it('builds its own wherever CI is set, so CI never trusts a template it did not build', () => {
    expect(resolveTemplateMode({ CI: 'true' }, true).mode).toBe('fresh');
    expect(resolveTemplateMode({ CI: '1' }, true).mode).toBe('fresh');
  });

  it('reads CI=false, CI=0 and an empty CI as not CI', () => {
    for (const CI of ['false', '0', '']) {
      expect(resolveTemplateMode({ CI }, true).mode).toBe('shared');
    }
  });

  it('lets the variable decide either way, on CI or off it', () => {
    expect(resolveTemplateMode({ TEST_TEMPLATE_MODE: 'fresh' }, true).mode).toBe('fresh');
    expect(resolveTemplateMode({ TEST_TEMPLATE_MODE: 'shared', CI: 'true' }, true).mode).toBe(
      'shared',
    );
  });

  it('reads an empty variable as unset', () => {
    expect(resolveTemplateMode({ TEST_TEMPLATE_MODE: '' }, true).mode).toBe('shared');
  });

  it('builds its own on a container, which no other run can see', () => {
    expect(resolveTemplateMode({}, false).mode).toBe('fresh');
  });

  it('refuses a mode it does not know, naming it and what is valid', () => {
    expect(() => resolveTemplateMode({ TEST_TEMPLATE_MODE: 'share' }, true)).toThrow(
      /TEST_TEMPLATE_MODE="share".*"shared".*"fresh"/s,
    );
  });

  it('refuses shared with no instance to share on', () => {
    expect(() => resolveTemplateMode({ TEST_TEMPLATE_MODE: 'shared' }, false)).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it('says which rule chose', () => {
    expect(resolveTemplateMode({ CI: 'true' }, true).rule).toMatch(/CI/);
    expect(resolveTemplateMode({ TEST_TEMPLATE_MODE: 'fresh' }, true).rule).toMatch(
      /TEST_TEMPLATE_MODE=fresh/,
    );
  });
});

describe('the completeness marker', () => {
  it('round-trips', () => {
    const m = { content: 'ab12', built: 5, used: 9 };
    expect(parseMarker(formatMarker(m))).toEqual(m);
  });

  it('reads a comment this suite did not write as no marker', () => {
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker('')).toBeNull();
    expect(parseMarker('forge-template v2 content=ab built=1 used=1')).toBeNull();
    expect(parseMarker('forge-template v1 content=ab built=1')).toBeNull();
  });
});

describe('the connection that holds a run’s lock', () => {
  it('is never recycled, which postgres.js does after 30 to 60 minutes unless told not to', () => {
    const held = postgres('postgres://u:p@127.0.0.1:1/x', HOLDER_OPTIONS);
    const recycled = postgres('postgres://u:p@127.0.0.1:1/x', { max: 1 });
    try {
      expect(held.options.max_lifetime).toBe(0);
      expect(typeof recycled.options.max_lifetime).toBe('function');
    } finally {
      void held.end({ timeout: 0 });
      void recycled.end({ timeout: 0 });
    }
  });
});
