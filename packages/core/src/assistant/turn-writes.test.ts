import { describe, expect, it } from 'vitest';
import { filingTitle, turnWrites } from './turn-writes.js';

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

describe('a record from chat is made once per turn and title', () => {
  it('answers a second filing under the same title with the first, and says so', async () => {
    const t = tracker();
    const writes = turnWrites(t.tools);
    await writes.tools?.execute('forge_feedback', filing('Tags sync from Hub to Helpdesk'));
    const again = await writes.tools?.execute(
      'forge_feedback',
      filing('  tags sync from hub to helpdesk. '),
    );
    expect(t.filed()).toBe(1);
    const said = again?.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(said).toContain('Not recorded again');
    expect(said).toContain('FB-1');
  });

  it('files once when the model files the same title twice in one round', async () => {
    const t = tracker();
    const writes = turnWrites(t.tools);
    await Promise.all([
      writes.tools?.execute('forge_feedback', filing('Same title')),
      writes.tools?.execute('forge_feedback', filing('Same title')),
    ]);
    expect(t.filed()).toBe(1);
  });

  it('files again after a refused filing, and files a different title', async () => {
    const t = tracker(true);
    const writes = turnWrites(t.tools);
    await writes.tools?.execute('forge_feedback', filing('First'));
    await writes.tools?.execute('forge_feedback', filing('First'));
    await writes.tools?.execute('forge_feedback', filing('Second'));
    expect(t.filed()).toBe(2);
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
});
