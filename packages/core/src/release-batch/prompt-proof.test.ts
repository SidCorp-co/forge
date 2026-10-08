// What a release run is told about proving its release: where Forge reads and when, and where
// nothing can (ISS-1321, ISS-1282).

import { describe, expect, it } from 'vitest';
import { releaseBatchStatePrompt } from '../prompt/state-prompts/release-batch.js';
import { RELEASE_BATCH_TOOL, type ReleaseChannel, type ReleasePlan } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';

const BASE = {
  runId: 'run-1',
  projectId: 'proj-1',
  baseBranch: 'dev',
  releaseChain: [{ branch: 'dev' }, { branch: 'master', from: 'merge-branch' as const }],
  issues: [{ id: 'i1', displayId: 'ISS-9', title: 'checkout 500s' }],
  releaseRunnerPreferenceMet: true,
};

const channel = (over: Partial<ReleaseChannel> = {}): ReleaseChannel => ({
  bindingId: 'b-1',
  provider: 'coolify',
  label: '',
  instructions: null,
  releaseRunnerLabel: null,
  verify: null,
  verifySource: 'none',
  rollback: null,
  ...over,
});

const plan = (over: Partial<ReleasePlan> = {}): ReleasePlan => ({
  channels: [],
  releaseRunnerLabel: null,
  procedure: null,
  ...over,
});

describe('the proof a release run is told about (ISS-1282)', () => {
  const probed = plan({
    channels: [
      channel({
        verify: { probes: [{ url: 'https://example.test/version' }] },
        verifySource: 'binding',
      }),
    ],
  });

  // ISS-1282 — the agent decides when Forge reads, and the roster closes on what Forge kept.
  it('tells the agent to look once the deploy is made, and that when and how often is its own call', () => {
    for (const text of [
      buildReleaseBatchPrompt({ ...BASE, plan: probed }),
      releaseBatchStatePrompt,
    ]) {
      expect(text).toMatch(new RegExp(`${RELEASE_BATCH_TOOL}\\\` action\\s+\\\`look\\\``));
      expect(text).toMatch(
        /You decide when (to look )?and how\s+often|You decide when and how\s+often/,
      );
    }
  });

  it('says a finish closes on the readings that were kept and on nothing the agent says', () => {
    const text = buildReleaseBatchPrompt({ ...BASE, plan: probed });
    expect(text).toMatch(/closes the roster on the kept readings and on nothing you say/);
    expect(text).toMatch(/a `finish` before them is refused RELEASE_NOT_VERIFIED, closes nothing/);
    expect(releaseBatchStatePrompt).toMatch(
      /closed on the readings `look` kept\s+and\s+on nothing you say/,
    );
  });

  it('keeps a healthy site still serving the old build a RED the agent cannot pass around', () => {
    const text = buildReleaseBatchPrompt({ ...BASE, plan: probed });
    expect(text).toMatch(
      /still serving the old build is a RED, and nothing you can pass to `finish`/,
    );
  });

  it('describes no window, timer or second finish after one, in either place the agent reads', () => {
    for (const text of [
      buildReleaseBatchPrompt({ ...BASE, plan: probed }),
      releaseBatchStatePrompt,
    ]) {
      expect(text).not.toMatch(/\bwindow\b|\btimer\b|five minutes|300 ?s|re-?finish/i);
      expect(text).not.toMatch(
        /call\s+`finish`\s+again\s+with\s+the\s+commit\s+you\s+last\s+pushed/,
      );
      expect(text).not.toMatch(/starts\s+a\s+new\s+attempt/);
    }
  });

  it('sends a deploy still coming up back to a later look and not to a failure', () => {
    for (const text of [
      buildReleaseBatchPrompt({ ...BASE, plan: probed }),
      releaseBatchStatePrompt,
    ]) {
      expect(text).toMatch(/still coming up is a reason to\s+(`look`\s+again|look again)/);
    }
  });
});

describe('the proof a release run is told about (ISS-1321)', () => {
  const probed = channel({
    verify: { probes: [{ url: 'https://api.example.test/version' }] },
    verifySource: 'binding',
  });

  it('says a project with no probe is read by nothing and closed unverified', () => {
    const out = buildReleaseBatchPrompt({ ...BASE, plan: plan({ channels: [channel()] }) });

    expect(out).toContain('### Proof (this project declares none)');
    expect(out).toContain('nothing for `look` to read and it is refused');
    expect(out).toContain('this release was NOT verified');
    expect(out).toContain('`finish.verification` reads `unverified`');
    expect(out).not.toContain('### Proof (Forge reads, you decide when)');
    expect(out).not.toMatch(/action `look` with `commit`/);
  });

  it('keeps the probed proof, and only it, where a probe is declared', () => {
    const out = buildReleaseBatchPrompt({ ...BASE, plan: plan({ channels: [probed] }) });

    expect(out).toContain('### Proof (Forge reads, you decide when)');
    expect(out).toContain('- https://api.example.test/version');
    expect(out).toMatch(/action `look` with `commit`/);
    expect(out).not.toContain('### Proof (this project declares none)');
  });

  it('lists the probes of every live binding that declares one, and names the ones that do not as unread', () => {
    const second = channel({
      bindingId: 'b-2',
      label: 'eu',
      verify: { probes: [{ url: 'https://eu.example.test/version' }] },
      verifySource: 'binding',
    });
    const out = buildReleaseBatchPrompt({
      ...BASE,
      plan: plan({ channels: [probed, second, channel({ bindingId: 'b-3', label: 'asia' })] }),
    });

    expect(out).toContain('- https://api.example.test/version');
    expect(out).toContain('- https://eu.example.test/version');
    expect(out).toContain('1 more live deploy binding declares no probe');
    expect(out).toContain('`look` names it as `unread`');
  });

  it('says nothing about an unread binding where every live binding declares a probe', () => {
    const out = buildReleaseBatchPrompt({ ...BASE, plan: plan({ channels: [probed] }) });

    expect(out).not.toContain('declares no probe');
    expect(out).not.toContain('`unread`');
  });

  it('prints no proof at all where nothing deploys', () => {
    const out = buildReleaseBatchPrompt({ ...BASE, plan: plan() });

    expect(out).not.toContain('### Proof');
  });
});
