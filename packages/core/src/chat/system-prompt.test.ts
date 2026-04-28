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
});
