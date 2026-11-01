import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, chatGatesBlock } from './system-prompt.js';

describe('REQ-76 BC-9: a chat reads what its project gate profile lets it do', () => {
  it('says nothing where chat_files_issue is enforced, the base rule standing', () => {
    expect(chatGatesBlock({ mode: 'enforce', profile: 'standard' })).toBeNull();
    const prompt = buildSystemPrompt({ project: { name: 'p' }, gates: null });
    expect(prompt).not.toContain('gate profile');
  });

  it('tells a yolo chat it may file the issue itself, with no confirm step (ISS-861)', () => {
    const block = chatGatesBlock({ mode: 'off', profile: 'yolo' });
    const prompt = buildSystemPrompt({ project: { name: 'p' }, gates: block });
    expect(prompt).toContain('a chat may file an issue itself');
    expect(prompt).not.toContain('confirm');
    expect(prompt).toContain('`yolo` gate profile');
  });
});
