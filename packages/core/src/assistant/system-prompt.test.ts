import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './system-prompt.js';

/**
 * What `origin/dev` 0bbb1a55f rendered for a project storing `systemPrompt: 'answer in Vietnamese'`
 * and `personaStyle: 'be terse'`: the persona line, the project's addition under it, and a style
 * section. The two project lines are the whole difference.
 */
const BEFORE = [
  'You are a helpful assistant for project "Mowment".\nanswer in Vietnamese',
  'Reply style & personality (project-configured):\nbe terse',
  'Progress: 3 shipped.',
].join('\n\n');

describe('the assistant prompt with the project keys deleted', () => {
  it('renders the default persona and no project addition', () => {
    const after = buildSystemPrompt({
      project: { name: 'Mowment' },
      progressFacts: 'Progress: 3 shipped.',
    });
    expect(after).toBe(
      ['You are a helpful assistant for project "Mowment".', 'Progress: 3 shipped.'].join('\n\n'),
    );
    expect(
      BEFORE.replace('\nanswer in Vietnamese', '').replace(
        '\n\nReply style & personality (project-configured):\nbe terse',
        '',
      ),
    ).toBe(after);
  });

  it('keeps a channel persona, which is not a project key', () => {
    const after = buildSystemPrompt({
      project: { name: 'Mowment' },
      persona: 'You answer in chat.',
    });
    expect(after).toBe('You answer in chat.');
  });

  it('accepts no agentConfig on the project it renders for', () => {
    // @ts-expect-error the project summary carries a name and nothing a project stored
    buildSystemPrompt({ project: { name: 'Mowment', agentConfig: { personaStyle: 'x' } } });
  });
});

describe('the content language block', () => {
  const block = "## Content language\nThis project's content language is Vietnamese (`vi`).";

  it('closes the prompt, after the progress facts', () => {
    const out = buildSystemPrompt({
      project: { name: 'Mowment' },
      progressFacts: 'Progress: 3 shipped.',
      contentLanguage: block,
    });
    expect(out.endsWith(block)).toBe(true);
    expect(out.indexOf('Progress: 3 shipped.')).toBeLessThan(out.indexOf(block));
  });

  it('survives a system prompt override, which replaces the persona and nothing else', () => {
    const out = buildSystemPrompt({
      project: { name: 'Mowment' },
      appConfig: { systemPromptOverride: 'You are Bob.' },
      contentLanguage: block,
    });
    expect(out).toBe(`You are Bob.\n\n${block}`);
  });
});
