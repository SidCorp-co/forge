import { describe, expect, it } from 'vitest';
import { ADDRESS_INHERITED_OPEN_ITEMS, CONSUMES_OPEN_ITEMS, getStatePrompt } from './index.js';

const OBLIGATION_MARKER = 'Address inherited open items';

describe('state-prompts — test verification outcomes', () => {
  const test = getStatePrompt('test') ?? '';

  it('parks fixture blocks with their required reason and resource kind', () => {
    expect(test).toContain('blocked_fixture');
    expect(test).toContain('resultReason');
    expect(test).toContain("waitingKind: 'needs_resource'");
  });

  it('parks automated verification evidence for a human decision', () => {
    expect(test).toContain('verified_by_test');
    expect(test).toContain("waitingKind: 'needs_decision'");
  });
});

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
    // cm:why the reason must survive rewording — it is what makes the order non-arbitrary
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

// cm:guard every stage that can park must name `needs` and not only `reason`: the question a person answers is minted from `needs` alone, and a stage prompt saying "with specific questions" sends those questions into prose nobody can answer (ISS-996).
describe('state-prompts — a `needs_info` park names what would settle it', () => {
  it.each(['triage', 'clarify', 'plan', 'code'] as const)('%s names `needs`', (step) => {
    const prompt = getStatePrompt(step) ?? '';
    expect(prompt).toContain('needs_info');
    expect(prompt).toContain('`needs`');
  });
});

/**
 * ISS-1042 criterion 39 — the English-only rule covers the CHANGELOG only.
 *
 * It read "English-only: all output, comments, changelog", which swept in every
 * comment a release agent writes. On a project whose issues, thread and
 * operators work in another language, that is a release run answering in a
 * language nobody there reads — for a rule that only ever existed because a
 * changelog is a published artefact.
 */
describe('state-prompts — the batch release language rule', () => {
  const releaseBatch = getStatePrompt('release_batch') ?? '';

  // cm:guard the negative half is what carries the claim. A prompt that names the changelog and
  // keeps the old blanket line beside it satisfies any assertion that only looks for the new one.
  it('binds the English requirement to the changelog and to nothing else', () => {
    expect(releaseBatch).toContain('The CHANGELOG entry is written in English');
    expect(releaseBatch).not.toContain('English-only');
    expect(releaseBatch).not.toMatch(/English[^.\n]*comments/);
  });

  it('says the rest goes in the language the project works in', () => {
    expect(releaseBatch).toMatch(/the language the project works in/);
  });

  // cm:guard the same repair-forward rule the task prompt carries, because the two are read in one
  // context window: a state block still naming a rollback is the contradiction the driver preamble
  // was measured resolving the wrong way in 2026-09-02.
  it('tells the release agent to repair forward rather than roll back', () => {
    expect(releaseBatch).toContain('REPAIR FORWARD');
    expect(releaseBatch).toContain('Never roll back');
  });
});
