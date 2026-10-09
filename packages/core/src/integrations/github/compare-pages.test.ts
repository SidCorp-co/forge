import { describe, expect, it } from 'vitest';
import { COMPARE_FILE_CEILING, readCompareFiles } from './compare-pages.js';

const files = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ filename: `f${from + i}.ts`, status: 'modified' }));

/** A repository answering one compare in pages of 100, the way GitHub does. */
function repo(total: number) {
  const asked: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    asked.push(path);
    const page = Number(/&page=(\d+)/.exec(path)?.[1]);
    const from = (page - 1) * 100;
    return { status: 'ahead', files: files(from, Math.max(0, Math.min(100, total - from))) } as T;
  };
  return { get, asked };
}

describe('readCompareFiles', () => {
  it('takes every page of a compare that runs to several hundred files', async () => {
    const r = repo(470);
    const read = await readCompareFiles(r.get, '/repos/o/r/compare/a...b');
    expect('why' in read).toBe(false);
    if ('why' in read) return;
    expect(read.files).toHaveLength(470);
    expect(read.status).toBe('ahead');
    expect(r.asked).toHaveLength(5);
  });

  it('answers a compare of exactly one full page by asking for the next, which is empty', async () => {
    const r = repo(100);
    const read = await readCompareFiles(r.get, '/c');
    expect('files' in read && read.files.length).toBe(100);
    expect(r.asked).toHaveLength(2);
  });

  it('refuses by name a compare that fills every page the repository will name', async () => {
    const read = await readCompareFiles(repo(COMPARE_FILE_CEILING + 50).get, '/c');
    expect(read).toEqual({
      why: expect.stringContaining(`${COMPARE_FILE_CEILING} or more files differ`),
    });
  });

  it('refuses a page that names no file list instead of reading it as an empty compare', async () => {
    const read = await readCompareFiles(async <T>() => ({ status: 'ahead' }) as T, '/c');
    expect(read).toEqual({ why: 'the compare answered no file list' });
  });
});
