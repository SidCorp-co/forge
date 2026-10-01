import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from './diff.js';
import { diffMcpTools, toolsOf } from './schema-diff.js';

interface Replayed {
  change: string;
  coreCommit: string;
  landedAt: string;
  pluginFollowedIn: string;
  tool: string;
  before: { name: string; inputSchema: object };
  after: { name: string; inputSchema: object };
  breaking: string[];
}

// cm:why the tools forge-plugin had to follow, cut to the paths that changed from artifacts generated at each landing and its first parent by today's generator; the generation is not reproducible here because it installs each old tree
const replay: {
  measuredBreaking: Replayed[];
  notMeasuredBreaking: { change: string; landedAt: string; measured: string; why: string }[];
} = JSON.parse(readFileSync(new URL('./fixtures/replay.json', import.meta.url), 'utf8'));
const replayed = replay.measuredBreaking;

const tools = (t: { name: string; inputSchema: object }) => {
  const m = toolsOf({ tools: [{ description: 'replayed', ...t }] });
  if (!m) throw new Error(`${t.name} is not a tool`);
  return m;
};

describe('core changes forge-plugin had to follow measure breaking', () => {
  it.each(replayed.map((r) => [r.change, r] as const))('%s', (_n, r) => {
    const changes = diffMcpTools(tools(r.before), tools(r.after));
    expect(classify(changes)).toBe('breaking');
    expect(changes.filter((c) => c.level === 'breaking').map((c) => c.text)).toEqual(r.breaking);
  });
});

// cm:why the rest of the replay: behaviour, an addition, or a body no validator declared then; a land measures each as it is, and the semantic route is how a provider says it breaks
describe('the replayed changes that do not measure breaking each say why', () => {
  it('names the landing and the reason for every one, and the two lists cover the ten followed changes', () => {
    for (const r of replay.notMeasuredBreaking) {
      expect(r.landedAt).toMatch(/^[0-9a-f]{40}$/);
      expect(r.why.length).toBeGreaterThan(20);
    }
    expect(replay.measuredBreaking.length + replay.notMeasuredBreaking.length).toBe(10);
  });
});
