/**
 * Carry the images that arrived with a chat turn onto the issue the model
 * files, or comments on, during that same turn.
 *
 * Server-side, not a tool the model calls: the picture is the whole report on
 * a "look at this" message, and a model that must remember to attach it
 * forgets on the turn it matters. The upload is the CLI's own `forge attach`,
 * run through the same `forge` tool once a `new` or a `comment` has landed, so
 * the mime allowlist, the name-collision read and the size caps stay where the
 * terminal's are.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { env } from '../../config/env.js';
import type { CallToolResult } from '../../mcp/tool-result.js';
import { base64Bytes, type TurnImage } from '../vision.js';
import type { ChatToolset } from './mcp-adapter.js';

const CLI_TOOL = 'forge';

/** What one `forge attach` call carries; the vision budget in `vision.ts`
 *  already bounds what a turn can be holding. */
const MAX_ATTACHED = 10;

const ISSUE_KEY = /\bISS-\d+\b/;

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Trim the set to what the ticket service will take, newest-first; what is
 * cut is named in the block the model reads, never dropped in silence.
 */
function withinPersistLimits(images: readonly TurnImage[]): { kept: TurnImage[]; cut: string[] } {
  const kept: TurnImage[] = [];
  const cut: string[] = [];
  for (const image of images) {
    if (kept.length >= MAX_ATTACHED || base64Bytes(image.dataBase64) > env.UPLOADS_MAX_BYTES) {
      cut.push(image.name);
      continue;
    }
    kept.push(image);
  }
  return { kept, cut };
}

function argvOf(argsJson: string): string[] | null {
  try {
    const argv = (JSON.parse(argsJson) as { argv?: unknown }).argv;
    return Array.isArray(argv) && argv.every((a) => typeof a === 'string') ? argv : null;
  } catch {
    return null;
  }
}

function runOf(result: CallToolResult): CliRun | null {
  const first = result.content[0];
  if (first?.type !== 'text') return null;
  try {
    const run = JSON.parse(first.text) as Partial<CliRun>;
    return typeof run.exitCode === 'number' && typeof run.stdout === 'string'
      ? { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr ?? '' }
      : null;
  } catch {
    return null;
  }
}

// cm:guard the key is read from where each verb PUTS the report and nowhere else: `new` names it in its own stdout (`ISS-n is filed, …`) and on the fold path that is the NEIGHBOUR's key, which is where the report went; `comment` names it in argv[1] and only when a `-` body rides along, because the same verb with no body is the thread read. No other verb a chat turn runs lands a report, so no other verb earns the pictures (ISS-1009).
function landedOn(argv: readonly string[], stdout: string): string | null {
  if (argv[0] === 'new') return stdout.match(ISSUE_KEY)?.[0] ?? null;
  if (argv[0] === 'comment' && argv.includes('-')) return argv[1] ?? null;
  return null;
}

/** File names as the reporter sees them, made safe as paths and unique within the set. */
function fileNames(images: readonly TurnImage[]): string[] {
  const seen = new Set<string>();
  return images.map((image, i) => {
    const base = basename(image.name).replace(/[^\w.-]+/g, '_') || `image-${i + 1}`;
    const name = seen.has(base) ? `${i + 1}-${base}` : base;
    seen.add(name);
    return name;
  });
}

async function attach(
  inner: ChatToolset,
  target: string,
  images: readonly TurnImage[],
  cut: readonly string[],
): Promise<{ type: 'text'; text: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-chat-images-'));
  try {
    const names = fileNames(images);
    const paths = await Promise.all(
      names.map(async (name, i) => {
        const path = join(dir, name);
        await writeFile(path, Buffer.from(images[i]?.dataBase64 ?? '', 'base64'));
        return path;
      }),
    );
    const result = await inner.execute(
      CLI_TOOL,
      JSON.stringify({ argv: ['attach', 'issue', target, ...paths] }),
    );
    const run = runOf(result) ?? {
      exitCode: result.isError ? 1 : 0,
      stdout: '',
      stderr: result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    };
    return {
      type: 'text',
      text: JSON.stringify({
        attached: { to: target, files: names, skipped: cut, ...run },
      }),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Wrap `inner` so a `forge new` or a `forge comment … -` that LANDS in this turn
 * is followed by `forge attach issue <key> <files>` carrying the turn's images,
 * and the model reads the attach result beside the write's. Every other call,
 * a write that did not land, and every turn with no images pass through
 * untouched.
 */
export function withTurnImages(inner: ChatToolset, images: readonly TurnImage[]): ChatToolset {
  const { kept, cut } = withinPersistLimits(images);
  if (kept.length === 0) return inner;
  return {
    tools: inner.tools,
    async execute(name, argsJson) {
      const result = await inner.execute(name, argsJson);
      if (name !== CLI_TOOL || result.isError) return result;
      const argv = argvOf(argsJson);
      const run = runOf(result);
      // cm:guard attach only AFTER the write returned exit 0: a refused `new` has no row to attach to, and the model's next call will be the corrected filing, which is the one that earns the pictures — attaching on the refusal would send them to whatever key the refusal text happened to name (ISS-1009).
      if (!argv || !run || run.exitCode !== 0) return result;
      const target = landedOn(argv, run.stdout);
      if (!target) return result;
      const block = await attach(inner, target, kept, cut);
      return { ...result, content: [...result.content, block] };
    },
  };
}
