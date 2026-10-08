import { describe, expect, it } from 'vitest';
import { toolError } from './tools/mcp-adapter.js';
import { filingTitle, isWriteCall, turnWrites } from './turn-writes.js';

const filing = (title: string) =>
  JSON.stringify({ kind: 'bug', title, body: 'x', screen: '/projects/hop/tags' });

function tracker(failFirst = false) {
  let filed = 0;
  let calls = 0;
  return {
    filed: () => filed,
    tools: {
      tools: [],
      ranAs: () => null,
      async execute() {
        calls += 1;
        if (failFirst && calls === 1) {
          return {
            content: [{ type: 'text' as const, text: 'No category named bugs.' }],
            isError: true,
          };
        }
        filed += 1;
        return { content: [{ type: 'text' as const, text: `{"feedback":{"key":"FB-${filed}"}}` }] };
      },
    },
  };
}

describe('what a turn already did, as a retry is told it', () => {
  it('lists a write that landed, and leaves out one that was refused', async () => {
    const t = tracker(true);
    const writes = turnWrites(t.tools);
    await writes.tools?.execute('forge_feedback', filing('First'));
    await writes.tools?.execute('forge_feedback', filing('Second'));
    expect(writes.calls().map((c) => c.write)).toEqual([true]);
    expect(writes.doneSoFar()).toContain('Second');
    expect(writes.doneSoFar()).not.toContain('First');
  });

  it('classes forge project new, --set, --archive and --unarchive as the writes they are, and a read as none', () => {
    const cli = (...argv: string[]) => isWriteCall('forge', JSON.stringify({ argv }));
    expect(cli('project', 'forge', '--set', 'name=Forge 2')).toBe(true);
    expect(cli('project', 'forge', '--set=name=Forge 2')).toBe(true);
    expect(cli('project', 'forge', '--archive')).toBe(true);
    expect(cli('project', 'forge', '--unarchive')).toBe(true);
    expect(cli('project', 'new', '--name', 'X', '--slug', 'x')).toBe(true);
    expect(cli('project')).toBe(false);
    expect(cli('project', 'forge')).toBe(false);
    expect(cli('project', 'forge', '--set', 'name=X', '-h')).toBe(false);
    expect(cli('issue', 'ISS-1', '--set', 'priority=high')).toBe(true);
    expect(cli('issue', 'ISS-1', '--unlink', 'e-1')).toBe(true);
  });

  it('keeps a held write apart from what landed: named once per proposal, never as done', async () => {
    const proposal = '00000000-0000-4000-8000-000000000001';
    const holding = {
      tools: [],
      ranAs: () => 'u',
      // the gate answers a held write as a tool error, its text wrapped as the adapter wraps it
      execute: async () =>
        toolError(
          `CHAT_WRITE_AWAITS_AGREEMENT: nothing was written. Core holds this comment as proposal ${proposal} (kind comment)`,
        ),
    };
    const writes = turnWrites(holding);
    const call = JSON.stringify({ argv: ['comment', 'ISS-61', '-'], body: 'x' });
    await writes.tools?.execute('forge', call);
    await writes.tools?.execute('forge', call);
    expect(writes.calls()).toEqual([]);
    expect(writes.doneSoFar()).toBeNull();
    expect(writes.held()).toEqual([{ name: 'forge', arguments: call, proposal, keys: ['ISS-61'] }]);
  });

  it('reads the title a record tool files under, and nothing from any other call', () => {
    expect(filingTitle('forge_feedback', filing('Hello'))).toBe('Hello');
    expect(filingTitle('forge_requirement_draft', JSON.stringify({ title: 'Panel width' }))).toBe(
      'Panel width',
    );
    expect(filingTitle('forge_requirement_revise', JSON.stringify({ title: 'x' }))).toBeNull();
    expect(filingTitle('forge', JSON.stringify({ argv: ['comment', 'ISS-1', '-'] }))).toBeNull();
    expect(filingTitle('forge_knowledge', filing('x'))).toBeNull();
  });

  it('takes a preview for the read it is, so the draft it showed is still recorded after it', async () => {
    const draft = { title: 'Panel width', criteriaFrom: { file: 'spec.md' } };
    expect(
      filingTitle('forge_requirement_draft', JSON.stringify({ ...draft, preview: true })),
    ).toBeNull();
    expect(
      isWriteCall('forge_requirement_draft', JSON.stringify({ ...draft, preview: true })),
    ).toBe(false);
    const t = tracker();
    const writes = turnWrites(t.tools);
    await writes.tools?.execute(
      'forge_requirement_draft',
      JSON.stringify({ ...draft, preview: true }),
    );
    await writes.tools?.execute('forge_requirement_draft', JSON.stringify(draft));
    expect(t.filed()).toBe(2);
  });
});
