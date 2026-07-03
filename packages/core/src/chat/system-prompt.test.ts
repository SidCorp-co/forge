import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './system-prompt.js';

describe('buildSystemPrompt', () => {
  it('uses project name when no override and no agentConfig', () => {
    const prompt = buildSystemPrompt({ project: { name: 'Acme' } });
    expect(prompt).toContain('Acme');
    expect(prompt).toContain('helpful assistant');
  });

  it('appends agentConfig.systemPrompt to the project line', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme', agentConfig: { systemPrompt: 'Be terse.' } },
    });
    expect(prompt).toContain('Acme');
    expect(prompt).toContain('Be terse.');
  });

  it('app_config.systemPromptOverride wins over project metadata', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme', agentConfig: { systemPrompt: 'Default.' } },
      appConfig: { systemPromptOverride: 'Custom override prompt.' },
    });
    expect(prompt.startsWith('Custom override prompt.')).toBe(true);
    expect(prompt).not.toContain('Default.');
    expect(prompt).not.toContain('helpful assistant');
  });

  it('appends serialized pageContext when provided', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      pageContext: { url: '/dash', user: 'jane' },
    });
    expect(prompt).toContain('Page context:');
    expect(prompt).toContain('"url": "/dash"');
    expect(prompt).toContain('"user": "jane"');
  });

  it('skips the page-context block when pageContext is empty', () => {
    const prompt = buildSystemPrompt({ project: { name: 'Acme' }, pageContext: {} });
    expect(prompt).not.toContain('Page context:');
  });

  it('whitespace-only override falls through to default project prompt', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      appConfig: { systemPromptOverride: '   ' },
    });
    expect(prompt).toContain('helpful assistant');
    expect(prompt).toContain('Acme');
  });

  // === ISS-609 — persona + conversationContext ===

  it('persona replaces the generic assistant line', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme', agentConfig: { systemPrompt: 'Be terse.' } },
      persona: 'You are the Forge channel bot.',
    });
    expect(prompt).toContain('You are the Forge channel bot.');
    expect(prompt).not.toContain('helpful assistant');
    expect(prompt).toContain('Be terse.'); // agentConfig prompt still appended
  });

  it('systemPromptOverride wins over persona', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      appConfig: { systemPromptOverride: 'Override.' },
      persona: 'Persona.',
    });
    expect(prompt.startsWith('Override.')).toBe(true);
    expect(prompt).not.toContain('Persona.');
  });

  it('conversationContext is appended even when an override is set', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      appConfig: { systemPromptOverride: 'Override.' },
      conversationContext: '[an]: deploy is failing',
    });
    expect(prompt).toContain('Conversation context');
    expect(prompt).toContain('[an]: deploy is failing');
  });

  it('blank conversationContext adds no section', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      conversationContext: '   ',
    });
    expect(prompt).not.toContain('Conversation context');
  });
});
