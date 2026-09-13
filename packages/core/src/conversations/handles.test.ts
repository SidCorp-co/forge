/**
 * ISS-1001 — the handle NAME, which is derived rather than chosen.
 *
 * The reuse-or-mint half of this module is a transaction over four tables and
 * an advisory lock; a mock of drizzle would assert the mock. It is walked in
 * `tests/integration/conversation-scope-e2e.test.ts` against a real Postgres,
 * including the two-connection race the lock exists for. What is testable here
 * is the rule that turns a project into an addressable name, and it is the one
 * `0239_conversations.sql` holds a third copy of.
 */

import { describe, expect, it } from 'vitest';
import { handleFromAgentEmail, isAgentHandle, synthesizeAgentEmail } from '../auth/agent-account.js';
import { handleNameForProject } from './handles.js';

const PROJECT_ID = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';

describe('handleNameForProject', () => {
  it('uses the slug when the slug is already addressable', () => {
    expect(handleNameForProject('forge-dev', PROJECT_ID)).toBe('forge-dev');
  });

  it('folds case and punctuation into one legal spelling', () => {
    expect(handleNameForProject('Forge Dev', PROJECT_ID)).toBe('forge-dev');
    expect(handleNameForProject('forge_dev.2', PROJECT_ID)).toBe('forge-dev-2');
    expect(handleNameForProject('--forge--dev--', PROJECT_ID)).toBe('forge-dev');
  });

  it('falls back to the project id when the slug can produce no legal handle', () => {
    expect(handleNameForProject('***', PROJECT_ID)).toBe('agent-da368b0a');
    expect(handleNameForProject('', PROJECT_ID)).toBe('agent-da368b0a');
    // cm:why one legal character is below `isAgentHandle`'s floor of three
    expect(handleNameForProject('x', PROJECT_ID)).toBe('agent-da368b0a');
  });

  it('never returns a name the agent-account rule would refuse', () => {
    for (const slug of ['forge-dev', 'Forge Dev', '***', '', 'x', 'a'.repeat(80), '你好']) {
      expect(isAgentHandle(handleNameForProject(slug, PROJECT_ID))).toBe(true);
    }
  });

  it('survives the round trip through the address that is the only place it is stored', () => {
    const handle = handleNameForProject('forge-dev', PROJECT_ID);
    expect(handleFromAgentEmail(synthesizeAgentEmail(handle))).toBe(handle);
  });
});
