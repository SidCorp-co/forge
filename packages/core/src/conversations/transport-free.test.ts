import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));

const TRANSPORT_WORDS = [
  'rocketchat',
  'RocketChat',
  'telegram',
  'Telegram',
  'widget',
  'slack',
  'Slack',
  'discord',
  'ddp',
];

function storeFiles(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/**
 * What an adapter may import from here: the contract it implements, and the neutral machinery it is
 * a CALLER of.
 */
const ADAPTER_FACING = [
  'ports.js',
  'turn-runner.js',
  'transcript.js',
  'collect-inbound.js',
  'route-window.js',
  'windows.js',
];

/**
 * Who may reach the store from outside this directory, whole-tree and frozen.
 */
const STORE_READERS_OUTSIDE = [
  'assistant/conversation-access.ts',
  'assistant/conversation-adapter.ts',
  'assistant/conversation-member-routes.ts',
  'assistant/conversation-routes.ts',
  'assistant/conversation-turn.ts',
  'assistant/routes.ts',
  'assistant/vision.ts',
];

function sourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = `${root}${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFilesUnder(`${full}/`));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function storeImportsIn(text: string): string[] {
  return [...text.matchAll(/from '(?:\.\.\/)+conversations\/([A-Za-z0-9_.-]+)'/g)].map(
    (m) => m[1] as string,
  );
}

describe('the conversation store knows no transport', () => {
  it('has store files to measure', () => {
    expect(storeFiles().length).toBeGreaterThan(3);
  });

  it('names no transport in any store module', () => {
    const offences: string[] = [];
    for (const file of storeFiles()) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      for (const word of TRANSPORT_WORDS) {
        if (text.includes(word)) offences.push(`${file} names "${word}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('is reached from no adapter tree, anywhere under integrations', () => {
    const root = fileURLToPath(new URL('../integrations/', import.meta.url));
    const offences: string[] = [];
    for (const file of sourceFilesUnder(root)) {
      for (const imported of storeImportsIn(readFileSync(file, 'utf8'))) {
        if (ADAPTER_FACING.includes(imported)) continue;
        offences.push(`${file.slice(root.length)} imports conversations/${imported}`);
      }
    }
    expect(offences.sort()).toEqual([]);
  });

  it('is reached from outside this directory only by the names frozen here', () => {
    const src = fileURLToPath(new URL('../', import.meta.url));
    const reaching = sourceFilesUnder(src)
      .filter((f) => !f.startsWith(dir))
      .filter((f) =>
        /from '[^']*conversations\/(store|participants)\.js'/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => f.slice(src.length))
      .sort();
    expect(reaching).toEqual(STORE_READERS_OUTSIDE);
  });

  it('imports nothing from the integrations tree', () => {
    const offences: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      if (/from '(\.\.\/)+integrations\//.test(text)) offences.push(`${file}`);
    }
    expect(offences).toEqual([]);
  });
});
