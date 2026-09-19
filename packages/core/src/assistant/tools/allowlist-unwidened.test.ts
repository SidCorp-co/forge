import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { CHAT_TOOL_ALLOWLIST } = await import('./registry.js');
const { buildChatToolContext } = await import('./principal.js');

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The allowlist as it stood at 87209b47, the commit ISS-1039 was cut from.
 */
const BEFORE_ISS_1039 = [
  'forge',
  'forge_guide',
  'forge_knowledge',
  'forge_memory.search',
  'forge_projects.get',
  'forge_pipeline_runs.get',
  'forge_project_pipeline_runs',
  'forge_metrics.project_step_durations',
  'forge_metrics.project_timeseries',
  'forge_preferences',
  'forge_memory.note',
];

const ctx = buildChatToolContext({
  userId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  projectSlug: 'alpha',
  turn: { conversationId: 'c1', speakerUserId: null, handleUserId: null },
});

describe('what a conversation turn can reach', () => {
  it('holds exactly the keys it held before Agent mode existed (criterion 38)', () => {
    expect(CHAT_TOOL_ALLOWLIST.map((s) => s.factory(ctx).name)).toEqual(BEFORE_ISS_1039);
  });

  it('is not what Agent mode reaches through (criteria 30, 39)', () => {
    const fork = readFileSync(join(HERE, '../conversation-send.ts'), 'utf8');
    const divert = fork.slice(fork.indexOf('divertBeforeTurn'), fork.indexOf('prepare: async'));
    expect(divert).toContain('startConversationAgentTurn');
    expect(divert).not.toContain('buildProjectToolset');
    expect(divert).not.toContain('CHAT_TOOL_ALLOWLIST');
  });
});
