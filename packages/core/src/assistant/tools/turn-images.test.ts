import { readFile } from 'node:fs/promises';
import { describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ env: { UPLOADS_MAX_BYTES: 10 * 1024 * 1024 } }));

import type { CallToolResult } from '../../mcp/tool-result.js';
import type { TurnImage } from '../vision.js';
import type { ChatToolset } from './mcp-adapter.js';
import { withTurnImages } from './turn-images.js';

const IMAGE: TurnImage = {
  name: 'shot.png',
  mime: 'image/png',
  ref: 'https://chat.example.com/file-upload/a/shot.png',
  dataBase64: 'QUJD',
};

const cliResult = (run: { exitCode: number; stdout: string; stderr?: string }): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ stderr: '', ...run }) }],
});

const FILED = cliResult({ exitCode: 0, stdout: 'ISS-7 is filed, as a bug with 0 gaps.' });
const ATTACHED = cliResult({ exitCode: 0, stdout: 'shot.png is up on ISS-7' });

interface Inner extends ChatToolset {
  execute: Mock<ChatToolset['execute']>;
  /** The bytes on disk at each attach path, read while the file still exists. */
  bytesSeen: string[];
}

/** An inner toolset whose first `forge` call answers `first` and whose attach call answers `ATTACHED`. */
function inner(first: CallToolResult): Inner {
  const bytesSeen: string[] = [];
  const execute = vi.fn<ChatToolset['execute']>(async (_name, argsJson) => {
    const { argv } = JSON.parse(argsJson) as { argv?: string[] };
    if (argv?.[0] !== 'attach') return first;
    for (const path of argv.slice(3)) bytesSeen.push((await readFile(path)).toString('utf8'));
    return ATTACHED;
  });
  return { tools: [], execute, bytesSeen };
}

const argvOf = (spy: Inner['execute'], call: number) =>
  (JSON.parse(spy.mock.calls[call]?.[1] as string) as { argv: string[] }).argv;

const textOf = (result: CallToolResult, i: number) => {
  const block = result.content[i];
  if (block?.type !== 'text') throw new Error(`block ${i} is not text`);
  return JSON.parse(block.text) as Record<string, unknown>;
};

describe('a report that landed earns the pictures', () => {
  it('attaches the turn image to the issue `forge new` filed, without the model asking', async () => {
    const set = inner(FILED);
    const out = await withTurnImages(set, [IMAGE]).execute(
      'forge',
      JSON.stringify({ argv: ['new', '-', '--title', 'the toggle is stuck'], body: '## Outcome' }),
    );
    expect(set.execute).toHaveBeenCalledTimes(2);
    const attachArgv = argvOf(set.execute, 1);
    expect(attachArgv.slice(0, 3)).toEqual(['attach', 'issue', 'ISS-7']);
    expect(attachArgv[3]).toMatch(/shot\.png$/);
    expect(set.bytesSeen).toEqual(['ABC']);
    expect(textOf(out, 1)).toMatchObject({
      attached: { to: 'ISS-7', files: ['shot.png'], exitCode: 0 },
    });
  });

  // cm:guard the fold path is where the neighbour's key comes back in `new`'s stdout — a wrapper that only knew the fresh path would attach nothing on exactly the turn `forge new` chose to fold, which is the turn ISS-1009 is about.
  it('follows a fold onto the neighbour the CLI named', async () => {
    const set = inner(
      cliResult({ exitCode: 0, stdout: 'Folded onto ISS-1446 as a comment; ISS-1446 is filed.' }),
    );
    await withTurnImages(set, [IMAGE]).execute('forge', JSON.stringify({ argv: ['new', '-'] }));
    expect(argvOf(set.execute, 1).slice(0, 3)).toEqual(['attach', 'issue', 'ISS-1446']);
  });

  it('attaches to the issue a comment with a body was posted on', async () => {
    const set = inner(cliResult({ exitCode: 0, stdout: 'comment landed' }));
    await withTurnImages(set, [IMAGE]).execute(
      'forge',
      JSON.stringify({ argv: ['comment', 'ISS-9', '-', '--title', 'Seen again'], body: 'x' }),
    );
    expect(argvOf(set.execute, 1).slice(0, 3)).toEqual(['attach', 'issue', 'ISS-9']);
  });

  it('reports what the attach itself said, beside the write', async () => {
    const set = inner(FILED);
    set.execute.mockImplementation(async (_n, argsJson) =>
      (JSON.parse(argsJson) as { argv: string[] }).argv[0] === 'attach'
        ? cliResult({ exitCode: 1, stdout: '', stderr: 'shot.png is already on ISS-7' })
        : FILED,
    );
    const out = await withTurnImages(set, [IMAGE]).execute(
      'forge',
      JSON.stringify({ argv: ['new', '-'] }),
    );
    expect(textOf(out, 0)).toMatchObject({ exitCode: 0 });
    expect(textOf(out, 1)).toMatchObject({
      attached: { exitCode: 1, stderr: 'shot.png is already on ISS-7' },
    });
  });
});

describe('what earns nothing', () => {
  it('a refused `new` — there is no row yet, and the next call is the real filing', async () => {
    const set = inner(
      cliResult({ exitCode: 1, stdout: '', stderr: 'one issue per problem: ISS-1446 is near' }),
    );
    await withTurnImages(set, [IMAGE]).execute('forge', JSON.stringify({ argv: ['new', '-'] }));
    expect(set.execute).toHaveBeenCalledTimes(1);
  });

  it('a comment with no body, which is the thread read', async () => {
    const set = inner(cliResult({ exitCode: 0, stdout: 'ISS-9  three comments' }));
    await withTurnImages(set, [IMAGE]).execute(
      'forge',
      JSON.stringify({ argv: ['comment', 'ISS-9'] }),
    );
    expect(set.execute).toHaveBeenCalledTimes(1);
  });

  it('a read, whatever key its output names', async () => {
    const set = inner(cliResult({ exitCode: 0, stdout: 'ISS-7 high open the toggle' }));
    await withTurnImages(set, [IMAGE]).execute(
      'forge',
      JSON.stringify({ argv: ['issue', '--search', 'toggle'] }),
    );
    expect(set.execute).toHaveBeenCalledTimes(1);
  });

  it('another tool, whatever it returns', async () => {
    const set = inner(FILED);
    const args = JSON.stringify({ query: 'ISS-7' });
    await withTurnImages(set, [IMAGE]).execute('forge_memory_search', args);
    expect(set.execute).toHaveBeenCalledTimes(1);
    expect(set.execute).toHaveBeenCalledWith('forge_memory_search', args);
  });

  it('a turn with no images — the wrapper is the identity', () => {
    const set = inner(FILED);
    expect(withTurnImages(set, [])).toBe(set);
  });

  it('arguments that are not JSON pass straight through so the tool reports them', async () => {
    const set = inner(FILED);
    set.execute.mockResolvedValue(FILED);
    const out = await withTurnImages(set, [IMAGE]).execute('forge', '{not json');
    expect(set.execute).toHaveBeenCalledTimes(1);
    expect(out).toBe(FILED);
  });
});

describe('the set is trimmed to what the ticket service takes, and says so', () => {
  it('names an oversized file as skipped rather than dropping it in silence', async () => {
    const set = inner(FILED);
    const big = {
      ...IMAGE,
      name: 'big.png',
      dataBase64: 'A'.repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3)),
    };
    const out = await withTurnImages(set, [big, IMAGE]).execute(
      'forge',
      JSON.stringify({ argv: ['new', '-'] }),
    );
    expect(textOf(out, 1)).toMatchObject({
      attached: { files: ['shot.png'], skipped: ['big.png'] },
    });
  });

  it('caps at ten files in one attach', async () => {
    const set = inner(FILED);
    const many = Array.from({ length: 14 }, (_, i) => ({ ...IMAGE, name: `s${i}.png` }));
    const out = await withTurnImages(set, many).execute(
      'forge',
      JSON.stringify({ argv: ['new', '-'] }),
    );
    expect(argvOf(set.execute, 1)).toHaveLength(13);
    expect((textOf(out, 1).attached as { skipped: string[] }).skipped).toHaveLength(4);
  });

  it('keeps two files of one name apart on disk', async () => {
    const set = inner(FILED);
    await withTurnImages(set, [IMAGE, { ...IMAGE, dataBase64: 'REVG' }]).execute(
      'forge',
      JSON.stringify({ argv: ['new', '-'] }),
    );
    const paths = argvOf(set.execute, 1).slice(3);
    expect(new Set(paths).size).toBe(2);
    expect(set.bytesSeen.sort()).toEqual(['ABC', 'DEF']);
  });
});
