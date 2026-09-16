// The fence ISS-1005 drew around what a conversation turn can reach, asserted
// against a literal copy of the set as it stood before ISS-1039 rather than
// against itself.
//
// ISS-1039 gave the Forge UI a second answer mode with a checkout and a shell,
// and the one way it could have been built cheaply is the one that issue
// forbids outright: widening this list. So the list is compared to a frozen
// copy, and Agent mode's reach is asserted to come from somewhere else.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// cm:why the same two mocks `tool-catalog-cost.test.ts` carries, for the same reason: building a
// tool context reaches the module that parses the environment, and a test about a LIST of names has
// no business needing a database URL to collect.
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
// cm:guard a LITERAL and not a snapshot read off the module under test: a test comparing the set to
// itself passes whatever the set becomes, which is the vacuous shape the same assertion took when it
// was first written. Adding a name here is the deliberate act of widening what a conversation turn
// can reach, and it belongs in an issue that says so (ISS-1039 criterion 38).
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

  // cm:guard the other half, and the one that says WHERE the reach came from instead: Agent mode
  // dispatches a runner session, and a session's tools are resolved by the dispatch path — so the
  // fork hands the turn to `startConversationAgentTurn` and builds no toolset at all. A divert that
  // reached for `buildProjectToolset` would be this list widened by another route.
  it('is not what Agent mode reaches through (criteria 30, 39)', () => {
    const fork = readFileSync(join(HERE, '../conversation-send.ts'), 'utf8');
    const divert = fork.slice(fork.indexOf('divertBeforeTurn'), fork.indexOf('prepare: async'));
    expect(divert).toContain('startConversationAgentTurn');
    expect(divert).not.toContain('buildProjectToolset');
    expect(divert).not.toContain('CHAT_TOOL_ALLOWLIST');
  });
});
