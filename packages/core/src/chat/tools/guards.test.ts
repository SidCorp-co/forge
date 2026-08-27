/**
 * ISS-868 — the chat fence over `forge_issues`. `guardIssueWrites` is a
 * denylist over a tool whose `data` schema grows without it: every field the
 * guard does not name is permitted, so a new side-effecting key on the MCP
 * side silently becomes reachable from a room the bot answers.
 */

import { expect, it } from 'vitest';
import { guardIssueWrites } from './guards.js';

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
