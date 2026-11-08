import { describe, expect, it } from 'vitest';
import type { ReleasePath } from '../project-config/index.js';
import type { ReleasePlan } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';

// ISS-955 (FB-492): a release run is told the commit each roster issue landed at, and that the head it
// cuts must hold every one, so it no longer tags a commit older than an issue it then closes.

const MARK = 'a'.repeat(40);
const path = { defaultBranch: 'dev', production: null, crossing: null } as unknown as ReleasePath;
const plan: ReleasePlan = { channels: [], releaseRunnerLabel: null, procedure: null };

const prompt = (marks: (string | null)[]) =>
  buildReleaseBatchPrompt({
    runId: 'run-1',
    projectId: 'project-1',
    defaultBranch: 'dev',
    path,
    plan,
    releaseRunnerPreferenceMet: true,
    issues: marks.map((markedCommit, n) => ({
      id: `issue-${n}`,
      displayId: `ISS-${n + 1}`,
      title: `Issue ${n + 1}`,
      markedCommit,
    })),
  });

describe('the release prompt names each roster issue’s marked commit (ISS-955)', () => {
  it('puts the marked commit on the issue’s roster line', () => {
    const text = prompt([MARK]);
    const line = text.split('\n').find((l) => l.startsWith('- ISS-1'));
    expect(line).toContain(`marked at \`${MARK}\``);
  });

  it('tells the run to cut from a head that holds every marked commit, or abort naming the issue', () => {
    const text = prompt([MARK, null]);
    expect(text).toContain('git merge-base --is-ancestor <commit> <head>');
    expect(text).toContain('abort naming that issue');
    expect(text.split('\n').find((l) => l.startsWith('- ISS-2'))).toContain('no commit marked');
  });

  it('says nothing of ancestry where no roster issue has a marked commit', () => {
    const text = prompt([null, null]);
    expect(text).not.toContain('merge-base');
  });
});

// ISS-1077: a production of several sites tells the run each site, its origin and probe, and that its
// finish names every one; a production of one site reads as it always has.
describe('the release prompt over production sites (ISS-1077)', () => {
  const channel = (site: string, bindingId: string, url: string | null) => ({
    environment: 'live',
    site,
    url,
    bindingId,
    provider: 'coolify',
    label: '',
    instructions: null,
    releaseRunnerLabel: null,
    verify: url ? { probes: [{ url: `${url}/version`, commitPath: 'version' }] } : null,
    verifySource: url ? ('environment' as const) : ('none' as const),
    rollback: null,
  });
  const over = (channels: ReleasePlan['channels']) =>
    buildReleaseBatchPrompt({
      runId: 'run-1',
      projectId: 'project-1',
      defaultBranch: 'dev',
      path,
      plan: { ...plan, channels },
      releaseRunnerPreferenceMet: true,
      issues: [],
    });

  it('names each site on its channel line and asks the finish for every one', () => {
    const text = over([
      channel('live', 'b-mail', 'https://mail.example.test'),
      channel('webmail', 'b-webmail', 'https://webmail.example.test'),
    ]);
    expect(text).toContain(
      '- coolify, binding b-webmail: site `webmail`, https://webmail.example.test, verified by https://webmail.example.test/version',
    );
    expect(text).toContain('Production is 2 sites: `live`, `webmail`');
    expect(text).toContain('{"sites":[{"name":"<site>","serves":"<version or commit>"}]}');
    expect(text).toContain('RELEASE_SITE_NOT_SHIPPED');
  });

  it('says nothing of sites where production is one', () => {
    const text = over([channel('live', 'b-mail', 'https://mail.example.test')]);
    expect(text).toContain('- coolify, binding b-mail\n');
    expect(text).not.toContain('sites');
  });
});
