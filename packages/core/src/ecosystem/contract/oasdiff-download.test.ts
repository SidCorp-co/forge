// ISS-1138: the image build fetches the pinned oasdiff once, and one GitHub 504 failed a deploy. A
// transient answer is retried; any other answer fails at once by name.

import { describe, expect, it } from 'vitest';
import { DOWNLOAD_RETRY_WAITS_MS, downloadPinned } from './oasdiff.js';

type Answer = { ok: true; bytes: Buffer } | { ok: false; status: number } | Error;

function answering(...answers: Answer[]) {
  const calls: string[] = [];
  const download = async (url: string) => {
    calls.push(url);
    const next = answers.shift();
    if (!next) throw new Error('asked once too often');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, download };
}

const waits: number[] = [];
const noWait = async (ms: number) => {
  waits.push(ms);
};
const URL = 'https://github.com/oasdiff/oasdiff/releases/download/v1/oasdiff.tar.gz';
const BYTES = Buffer.from('oasdiff');

describe('downloadPinned', () => {
  it('fetches past a 504 that the next attempt answers', async () => {
    const { calls, download } = answering({ ok: false, status: 504 }, { ok: true, bytes: BYTES });
    await expect(downloadPinned(URL, download, noWait)).resolves.toEqual(BYTES);
    expect(calls).toHaveLength(2);
  });

  it('retries a 429 and a network error alike', async () => {
    const { calls, download } = answering({ ok: false, status: 429 }, new Error('fetch failed'), {
      ok: true,
      bytes: BYTES,
    });
    await expect(downloadPinned(URL, download, noWait)).resolves.toEqual(BYTES);
    expect(calls).toHaveLength(3);
  });

  it('fails a 404 at once, naming the status', async () => {
    const { calls, download } = answering({ ok: false, status: 404 });
    await expect(downloadPinned(URL, download, noWait)).rejects.toThrow(
      `GET ${URL} answered HTTP 404`,
    );
    expect(calls).toHaveLength(1);
  });

  it('gives up after its last wait, naming every attempt', async () => {
    const tries = DOWNLOAD_RETRY_WAITS_MS.length + 1;
    const { calls, download } = answering(
      ...Array.from({ length: tries }, (): Answer => ({ ok: false, status: 503 })),
    );
    waits.length = 0;
    await expect(downloadPinned(URL, download, noWait)).rejects.toThrow(
      `GET ${URL} failed ${tries} times: ${Array(tries).fill('HTTP 503').join(', ')}`,
    );
    expect(calls).toHaveLength(tries);
    expect(waits).toEqual([...DOWNLOAD_RETRY_WAITS_MS]);
  });
});
