import { describe, expect, it } from 'vitest';
import { ADDRESS_INHERITED_OPEN_ITEMS, CONSUMES_OPEN_ITEMS, getStatePrompt } from './index.js';

const OBLIGATION_MARKER = 'Address inherited open items';

describe('state-prompts — ADDRESS_INHERITED_OPEN_ITEMS obligation (ISS-537)', () => {
  it('consuming steps (plan/code/review/test/fix) carry the open-items obligation', () => {
    for (const step of ['plan', 'code', 'review', 'test', 'fix'] as const) {
      const prompt = getStatePrompt(step);
      expect(prompt, `${step} should contain obligation`).not.toBeNull();
      expect(prompt, `${step} missing obligation`).toContain(OBLIGATION_MARKER);
    }
  });

  it('non-consuming steps (clarify/triage/release) do NOT carry the obligation', () => {
    for (const step of ['clarify', 'triage', 'release'] as const) {
      const prompt = getStatePrompt(step);
      expect(prompt, `${step} should not contain obligation`).not.toContain(OBLIGATION_MARKER);
    }
  });

  it('CONSUMES_OPEN_ITEMS set includes exactly plan/code/review/test/fix', () => {
    expect(CONSUMES_OPEN_ITEMS.has('plan')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('code')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('review')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('test')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('fix')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('clarify')).toBe(false);
    expect(CONSUMES_OPEN_ITEMS.has('triage')).toBe(false);
    expect(CONSUMES_OPEN_ITEMS.has('release')).toBe(false);
  });

  it('ADDRESS_INHERITED_OPEN_ITEMS mentions re-query flow and max-3 cap', () => {
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('forge_agent_sessions.list');
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('forge_agent_sessions.get');
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('max 3 calls');
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('last-20 message tail');
  });

  it('ADDRESS_INHERITED_OPEN_ITEMS explicitly states prompt-layer guidance, not a status gate', () => {
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('not a status gate');
  });
});

/**
 * Skills fork per project at adoption and never merge back, so an invariant
 * written into a skill body reaches only projects bootstrapped after it.
 * anhome ISS-362/ISS-399 stalled at `released` twice against anhome's own
 * forked forge-release; fixing the shared template did not reach it. These
 * pin the invariant to the layer that DOES reach every project.
 */
describe('state-prompts — release terminal-exit invariant lives in the non-forking layer', () => {
  const release = getStatePrompt('release') ?? '';

  it('forbids exiting while the issue is still at `released`', () => {
    expect(release).toMatch(/FORBIDDEN/);
    expect(release).toMatch(/still at\s+\\?`released\\?`/);
  });

  it('enumerates all three legal exits', () => {
    for (const status of ['closed', 'reopen', 'waiting']) {
      expect(release, `missing exit ${status}`).toContain(status);
    }
  });

  it('orders the close BEFORE cleanup, and marks cleanup best-effort', () => {
    expect(release).toContain('best-effort');
    expect(release).toMatch(/AFTER the close/);
    // The reason must survive rewording — it is why the order is not arbitrary.
    expect(release).toMatch(/only action that stops this stage being re-dispatched/);
  });

  it('requires remote verification and rejects a push exit code as evidence', () => {
    expect(release).toContain('REMOTE');
    expect(release).toContain('push exit code');
  });

  it('tells a re-dispatched attempt to establish prior state before redoing work', () => {
    expect(release).toMatch(/re-dispatch/);
    expect(release).toMatch(/never blindly re-merge/);
  });

  // cm:guard POLICY here, PROCEDURE in the per-project skill — anhome merges nothing at this stage (batched cutoff), so a default that hardcodes a merge would contradict its skill.
  it('defers the merge decision to the project skill instead of mandating one', () => {
    expect(release).toContain("governed by the project's adopted");
    expect(release).toMatch(/promote in batches and merge nothing here/);
  });
});

/**
 * epodsystem-core reported the same conflict four times: `previewDeploy
 * .stagingUrl` is set, so the skill's deploy-mode heuristic picks "deploy",
 * but `forge_coolify_deploy list` is empty so the call is a guaranteed no-op
 * (`reason: "no-integration"`). Worse, that stagingUrl actually served
 * production from master, so forge-test QA'd stale code against it.
 */
describe('state-prompts — code stage resolves deploy target from reality, not config strings', () => {
  const code = getStatePrompt('code') ?? '';

  it('treats an empty Coolify list as decisive', () => {
    expect(code).toContain('DECISIVE');
    expect(code).toMatch(/no-integration/);
  });

  it('refuses to accept previewDeploy.stagingUrl as a deploy target on its own', () => {
    expect(code).toMatch(/stagingUrl.*is not a target|not a target/);
    expect(code).toMatch(/or at production/);
  });

  it('keeps the pre-existing same-branch merge guard (brand-gateway ISS-11)', () => {
    expect(code).toMatch(/no safe pre-prod merge target/);
  });
});
