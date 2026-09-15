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

  describe('the self (ISS-1034)', () => {
    it('renders soul and greeting before the persona and instructions after it (criterion 3)', () => {
      const prompt = buildSystemPrompt({
        project: { name: 'Acme' },
        persona: 'PERSONA LINE',
        self: {
          soul: 'Patient and exact.',
          greeting: 'Hello there.',
          emoji: '🦞',
          instructions: 'Cite issue keys.',
        },
      });
      const who = prompt.indexOf('## Who you are\nPatient and exact.');
      const persona = prompt.indexOf('PERSONA LINE');
      const instructions = prompt.indexOf('## Your standing instructions\nCite issue keys.');
      expect(who).toBeGreaterThanOrEqual(0);
      expect(persona).toBeGreaterThan(who);
      expect(instructions).toBeGreaterThan(persona);
      expect(prompt).toContain('You open with: Hello there.');
      expect(prompt).toContain('🦞');
    });

    it('renders nothing of an empty self, so a handle with no row reads exactly as before (criterion 4)', () => {
      const bare = buildSystemPrompt({ project: { name: 'Acme' }, persona: 'PERSONA LINE' });
      expect(
        buildSystemPrompt({ project: { name: 'Acme' }, persona: 'PERSONA LINE', self: null }),
      ).toBe(bare);
      expect(
        buildSystemPrompt({
          project: { name: 'Acme' },
          persona: 'PERSONA LINE',
          self: { soul: '  ', instructions: null },
        }),
      ).toBe(bare);
    });

    it('the override replaces the self with the persona, and progressFacts still follows (criteria 8, 9)', () => {
      const prompt = buildSystemPrompt({
        project: { name: 'Acme' },
        persona: 'PERSONA LINE',
        self: { soul: 'Patient and exact.', instructions: 'Cite issue keys.' },
        appConfig: { systemPromptOverride: 'OVERRIDE.' },
        progressFacts: 'PROGRESS FACTS',
      });
      expect(prompt.startsWith('OVERRIDE.')).toBe(true);
      expect(prompt).not.toContain('Patient and exact.');
      expect(prompt).not.toContain('Cite issue keys.');
      expect(prompt).not.toContain('PERSONA LINE');
      expect(prompt.indexOf('PROGRESS FACTS')).toBeGreaterThan(0);
    });
  });
});
