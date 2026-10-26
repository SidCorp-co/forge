import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isEntrypoint } from './entrypoint.js';

const scratch = mkdtempSync(join(tmpdir(), 'core-entrypoint-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('isEntrypoint — ISS-1236 r6', () => {
  const dir = join(scratch, 'a checkout');
  mkdirSync(dir);
  const file = join(dir, 'index.js');
  writeFileSync(file, '');
  symlinkSync(dir, join(scratch, 'linked'));
  const url = pathToFileURL(file).href;

  it('answers yes from a real path holding a space, whose URL is percent-encoded', () => {
    expect(url).toContain('%20');
    expect(isEntrypoint(url, file)).toBe(true);
  });

  it('answers yes when the process was launched through a symlinked folder', () => {
    expect(isEntrypoint(url, join(scratch, 'linked', 'index.js'))).toBe(true);
  });

  it('answers no for another file, a file that is not there, and no entry', () => {
    const other = join(dir, 'other.js');
    writeFileSync(other, '');
    expect(isEntrypoint(url, other)).toBe(false);
    expect(isEntrypoint(url, join(dir, 'absent.js'))).toBe(false);
    expect(isEntrypoint(url, '')).toBe(false);
  });
});
