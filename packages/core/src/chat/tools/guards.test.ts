/**
 * ISS-868 — the chat fence over `forge_issues`. `guardIssueWrites` is a
 * denylist over a tool whose `data` schema grows without it: every field the
 * guard does not name is permitted, so a new side-effecting key on the MCP
 * side silently becomes reachable from a room the bot answers.
 */

import { expect, it, vi } from 'vitest';
import { CHAT_REFUSED_DATA_KEYS, CHAT_TOLERATED_DATA_KEYS, guardIssueWrites } from './guards.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const { ISSUE_UPDATE_DATA_KEYS } = await import('../../mcp/tools/forge-issues.js');

const RETRACTION = {
  action: 'update',
  data: {
    relations: [
      {
        kind: 'blocks',
        dependsOnId: 'a5b0b0e2-0000-4000-8000-000000000001',
        validUntil: '2020-01-01T00:00:00.000Z',
      },
    ],
  },
};

it('refuses a dependency write from chat, whichever action carries it', () => {
  expect(guardIssueWrites(RETRACTION)).toMatch(/must not set issue dependencies/);
  expect(
    guardIssueWrites({
      action: 'create',
      data: {
        title: '[Bug] Listing breadcrumb overflows on long category paths',
        description: 'x'.repeat(250),
        relations: [{ kind: 'blocks', dependsOnId: 'a5b0b0e2-0000-4000-8000-000000000002' }],
      },
    }),
  ).toMatch(/must not set issue dependencies/);
});

it('refuses the dependency write before the create quality floor, so the reason is the real one', () => {
  const out = guardIssueWrites({
    action: 'create',
    data: { title: 'thin', description: 'thin', relations: [{ kind: 'blocks' }] },
  });
  expect(out).toMatch(/must not set issue dependencies/);
  expect(out).not.toMatch(/too thin/);
});

it('leaves an ordinary chat update alone', () => {
  expect(guardIssueWrites({ action: 'update', data: { status: 'waiting' } })).toBeNull();
  expect(guardIssueWrites({ action: 'update', data: {} })).toBeNull();
});

it('still refuses unblock and a dispatching status', () => {
  expect(guardIssueWrites({ action: 'update', data: { unblock: true } })).toMatch(/unblock/);
  expect(guardIssueWrites({ action: 'update', data: { status: 'approved' } })).toMatch(
    /leave that transition to a human/,
  );
});

// cm:edge contract -> packages/core/src/chat/tools/guards.ts — this is the checker half of the classification edge: the guard is open-by-default, so a `forge_issues` data key nobody classified is a key that reached chat with nobody deciding it should
it('forces every forge_issues data key to be classified refused or tolerated', () => {
  const classified = new Set([...CHAT_REFUSED_DATA_KEYS, ...CHAT_TOLERATED_DATA_KEYS]);
  const unclassified = ISSUE_UPDATE_DATA_KEYS.filter((k) => !classified.has(k));
  expect(unclassified).toEqual([]);
});

it('does not classify a key the update schema no longer has', () => {
  const schemaKeys = new Set<string>(ISSUE_UPDATE_DATA_KEYS);
  expect(CHAT_TOLERATED_DATA_KEYS.filter((k) => !schemaKeys.has(k))).toEqual([]);
});

it('refuses every key it declares refused', () => {
  for (const key of CHAT_REFUSED_DATA_KEYS) {
    expect(guardIssueWrites({ action: 'update', data: { [key]: 'x' } })).not.toBeNull();
  }
});
