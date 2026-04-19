import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPrompt, type PromptContext } from '../../../../strapi/src/services/agent/system-prompt';

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: 'TestProject',
    userKey: 'user:1',
    sessionSource: 'web',
    memories: [],
    providerName: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
  });

  // --- Layer 1: Identity ---
  it('includes project name in identity', () => {
    const result = buildSystemPrompt(makeCtx({ projectName: 'Acme App' }));
    expect(result).toContain('Forge AI');
    expect(result).toContain('"Acme App"');
  });

  // --- Layer 2: Core behavior ---
  it('includes core behavior instructions', () => {
    const result = buildSystemPrompt(makeCtx());
    expect(result).toContain('manage issues, tasks, and comments');
    expect(result).toContain('markdown');
  });

  // --- Layer 3: Project context ---
  it('includes project description when provided', () => {
    const result = buildSystemPrompt(makeCtx({ projectDescription: 'A bug tracker' }));
    expect(result).toContain('## Project Description');
    expect(result).toContain('A bug tracker');
  });

  it('omits project description when empty', () => {
    const result = buildSystemPrompt(makeCtx({ projectDescription: '  ' }));
    expect(result).not.toContain('## Project Description');
  });

  it('includes repos when provided', () => {
    const result = buildSystemPrompt(makeCtx({
      repos: [{ name: 'frontend' }, { url: 'https://github.com/org/backend' }],
    }));
    expect(result).toContain('## Repositories');
    expect(result).toContain('- frontend');
    expect(result).toContain('- https://github.com/org/backend');
  });

  it('omits repos when empty array', () => {
    const result = buildSystemPrompt(makeCtx({ repos: [] }));
    expect(result).not.toContain('## Repositories');
  });

  it('includes knowledge index as string', () => {
    const result = buildSystemPrompt(makeCtx({ knowledgeIndex: 'Some indexed docs' }));
    expect(result).toContain('## Knowledge Base');
    expect(result).toContain('Some indexed docs');
  });

  it('includes knowledge index as object (JSON)', () => {
    const result = buildSystemPrompt(makeCtx({ knowledgeIndex: { files: ['a.md'] } }));
    expect(result).toContain('## Knowledge Base');
    expect(result).toContain('"files"');
  });

  it('truncates knowledge index over 2000 chars', () => {
    const longIndex = 'x'.repeat(2500);
    const result = buildSystemPrompt(makeCtx({ knowledgeIndex: longIndex }));
    expect(result).toContain('…');
    // Should be truncated to 2000 + ellipsis
    const kbSection = result.split('## Knowledge Base\n')[1]?.split('\n\n')[0] || '';
    expect(kbSection.length).toBeLessThanOrEqual(2001);
  });

  // --- Layer 4: Guidelines ---
  it('includes agent prompt as guidelines', () => {
    const result = buildSystemPrompt(makeCtx({ agentPrompt: 'Always respond in Spanish' }));
    expect(result).toContain('## Project Guidelines');
    expect(result).toContain('Always respond in Spanish');
  });

  it('omits guidelines when agent prompt is empty', () => {
    const result = buildSystemPrompt(makeCtx({ agentPrompt: '' }));
    expect(result).not.toContain('## Project Guidelines');
  });

  it('omits guidelines when agent prompt is null/undefined', () => {
    const result = buildSystemPrompt(makeCtx({ agentPrompt: undefined }));
    expect(result).not.toContain('## Project Guidelines');
  });

  // --- Layer 5: Memory ---
  it('includes memories when provided', () => {
    const result = buildSystemPrompt(makeCtx({
      memories: [
        { category: 'preference', content: 'Prefers dark mode' },
        { category: 'context', content: 'Works on mobile team' },
      ],
    }));
    expect(result).toContain('## User Memory');
    expect(result).toContain('- [preference] Prefers dark mode');
    expect(result).toContain('- [context] Works on mobile team');
  });

  it('omits memory section when no memories', () => {
    const result = buildSystemPrompt(makeCtx({ memories: [] }));
    expect(result).not.toContain('## User Memory');
  });

  // --- Layer 6: Runtime ---
  it('includes runtime info with timestamp', () => {
    const result = buildSystemPrompt(makeCtx());
    expect(result).toContain('## Runtime');
    expect(result).toContain('2025-06-01T12:00:00.000Z');
    expect(result).toContain('Provider: anthropic');
    expect(result).toContain('Model: claude-sonnet-4-20250514');
    expect(result).toContain('Session source: web');
  });

  it('reflects widget session source', () => {
    const result = buildSystemPrompt(makeCtx({ sessionSource: 'widget' }));
    expect(result).toContain('Session source: widget');
  });

  // --- Layer 7: Tools ---
  it('includes tool descriptions', () => {
    const result = buildSystemPrompt(makeCtx({
      tools: [
        { name: 'forge_issues', description: 'List and search issues', inputSchema: {} },
        { name: 'forge_tasks', description: 'Manage tasks', inputSchema: {} },
      ],
    }));
    expect(result).toContain('## Available Tools');
    expect(result).toContain('**forge_issues**: List and search issues');
    expect(result).toContain('**forge_tasks**: Manage tasks');
  });

  it('omits tools section when no tools', () => {
    const result = buildSystemPrompt(makeCtx({ tools: [] }));
    expect(result).not.toContain('## Available Tools');
  });

  // --- Layer 8: Behavioral rules ---
  it('includes behavioral instructions', () => {
    const result = buildSystemPrompt(makeCtx());
    expect(result).toContain('## Instructions');
    expect(result).toContain('Chain multiple tool calls');
  });

  // --- Layer ordering ---
  it('outputs layers in correct order', () => {
    const result = buildSystemPrompt(makeCtx({
      projectDescription: 'Desc',
      agentPrompt: 'Guidelines here',
      memories: [{ category: 'pref', content: 'test' }],
      tools: [{ name: 't1', description: 'd1', inputSchema: {} }],
    }));

    const identityIdx = result.indexOf('Forge AI');
    const descIdx = result.indexOf('## Project Description');
    const guidelinesIdx = result.indexOf('## Project Guidelines');
    const memoryIdx = result.indexOf('## User Memory');
    const runtimeIdx = result.indexOf('## Runtime');
    const toolsIdx = result.indexOf('## Available Tools');
    const instructionsIdx = result.indexOf('## Instructions');

    expect(identityIdx).toBeLessThan(descIdx);
    expect(descIdx).toBeLessThan(guidelinesIdx);
    expect(guidelinesIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(runtimeIdx);
    expect(runtimeIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(instructionsIdx);
  });

  // --- Minimal context ---
  it('works with minimal context (no optional fields)', () => {
    const result = buildSystemPrompt(makeCtx());
    expect(result).toContain('Forge AI');
    expect(result).toContain('## Runtime');
    expect(result).toContain('## Instructions');
    expect(result).not.toContain('## Project Description');
    expect(result).not.toContain('## Project Guidelines');
    expect(result).not.toContain('## User Memory');
    expect(result).not.toContain('## Available Tools');
    expect(result).not.toContain('## Repositories');
    expect(result).not.toContain('## Knowledge Base');
  });

  // --- Full context ---
  it('includes all layers when fully populated', () => {
    const result = buildSystemPrompt(makeCtx({
      projectDescription: 'Full project',
      agentPrompt: 'Be helpful',
      repos: [{ name: 'repo1' }],
      knowledgeIndex: 'index data',
      memories: [{ category: 'c', content: 'm' }],
      tools: [{ name: 'tool1', description: 'desc1', inputSchema: {} }],
    }));

    expect(result).toContain('## Project Description');
    expect(result).toContain('## Repositories');
    expect(result).toContain('## Knowledge Base');
    expect(result).toContain('## Project Guidelines');
    expect(result).toContain('## User Memory');
    expect(result).toContain('## Runtime');
    expect(result).toContain('## Available Tools');
    expect(result).toContain('## Instructions');
  });

});
