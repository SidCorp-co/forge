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

  it('whitespace-only override falls through to default project prompt', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      appConfig: { systemPromptOverride: '   ' },
    });
    expect(prompt).toContain('helpful assistant');
    expect(prompt).toContain('Acme');
  });

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

  it('is byte-stable across turns: no per-turn input can reach it', () => {
    const input = {
      project: { name: 'Acme' },
      persona: 'Bot.',
      progressFacts: 'Project progress: 3 done.',
    };
    expect(buildSystemPrompt({ ...input })).toBe(buildSystemPrompt({ ...input }));
    expect(Object.keys(input)).not.toContain('conversationContext');
  });

  // === ISS-609 follow-up — personaStyle knob ===

  it('personaStyle appends a style section on top of the persona', () => {
    const prompt = buildSystemPrompt({
      project: {
        name: 'Acme',
        agentConfig: { personaStyle: 'Warm tone, address the user informally.' },
      },
      persona: 'You are the Forge channel bot.',
    });
    expect(prompt).toContain('You are the Forge channel bot.');
    expect(prompt).toContain('Reply style & personality');
    expect(prompt).toContain('Warm tone, address the user informally.');
  });

  it('personaStyle still applies when an override replaced the persona', () => {
    const prompt = buildSystemPrompt({
      project: {
        name: 'Acme',
        agentConfig: { personaStyle: 'Always end with a suggested action.' },
      },
      appConfig: { systemPromptOverride: 'Override.' },
    });
    expect(prompt.startsWith('Override.')).toBe(true);
    expect(prompt).toContain('Always end with a suggested action.');
  });

  it('progressFacts is appended even when an override is set', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      appConfig: { systemPromptOverride: 'Override.' },
      progressFacts: 'Project progress (computed by the system from live data — AUTHORITATIVE).',
    });
    expect(prompt).toContain('AUTHORITATIVE');
  });

  it('blank progressFacts adds no section', () => {
    const prompt = buildSystemPrompt({
      project: { name: 'Acme' },
      progressFacts: '   ',
    });
    expect(prompt).not.toContain('AUTHORITATIVE');
  });
});
