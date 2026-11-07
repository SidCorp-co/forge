/**
 * REQ-90 (ISS-1110, ISS-1112): a project's working agreements. Forge's nine defaults and the locked
 * guarantees are on every project from the start; a project admin overrides a default for a scope,
 * adds an agreement of the project's own, and restores or retires it, each a revision with its
 * reason and actor; a locked guarantee, an agreement another configuration owns and a stale write are
 * refused by name; a task gets the agreement its condition names; and a fresh session's orientation
 * carries the map. Against real Postgres.
 *
 * @direct-test-of packages/core/src/agreements/routes.ts
 * @direct-test-of packages/core/src/agreements/service.ts
 * @direct-test-of packages/core/src/agreements/store.ts
 * @direct-test-of packages/core/src/agreements/represented.ts
 * @direct-test-of packages/core/src/agreements/resolve.ts
 * @direct-test-of packages/core/src/prompt/checkout-orientation.ts
 * @direct-test-of packages/core/src/issues/label-service.ts
 */

import type { AgreementDetailView, AgreementsView } from '@forge/contracts/agreements';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { servedCheckoutOrientation } from '../../src/prompt/checkout-orientation.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const w = { projectId: '', slug: '', admin: '', member: '', billingIssue: '' };
const path = (rest = '') => `/api/projects/${w.projectId}/agreements${rest}`;
const list = async (query = '') => {
  const got = await api(w.member, 'GET', path(query));
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body as unknown as AgreementsView;
};
const of = (view: AgreementsView, slug: string) => view.agreements.find((a) => a.slug === slug);
const BILLING = {
  rule: 'Billing changes run the billing checks besides the scoped ones.',
  condition: { labels: ['billing'] },
  reason: 'Billing broke twice in October under scoped checks alone.',
};

beforeAll(async () => {
  const admin = await createTestUser({ verified: true });
  const member = await createTestUser({ verified: true });
  const project = await createTestProject(admin.id);
  w.projectId = project.id;
  w.slug = project.slug;
  await addProjectMember(w.projectId, admin.id, 'owner');
  await addProjectMember(w.projectId, member.id, 'member');
  w.admin = await userToken(admin.id);
  w.member = await userToken(member.id);
  await seedProjectDocument(w.projectId, admin.id, {
    environments: {
      beta: { tier: 'staging', deploysFrom: 'main', deployment: { mode: 'external' } },
    } as never,
  });
  w.billingIssue = (
    await createTestIssue(w.projectId, admin.id, 41, { status: 'open', createdAt: new Date() })
  ).id;
  const [label] = await rows<{ id: string }>(sql`
    INSERT INTO labels (project_id, name, color) VALUES (${w.projectId}, 'billing', '#cc0000') RETURNING id`);
  await db.execute(
    sql`INSERT INTO issue_labels (issue_id, label_id) VALUES (${w.billingIssue}, ${label?.id})`,
  );
});

describe('BC-13, BC-1: every project starts with Forge’s agreements', () => {
  it('lists the nine defaults, the locked guarantees and what its configuration holds, all inherited', async () => {
    const view = await list();
    expect(view.agreements.map((a) => a.slug)).toEqual(
      expect.arrayContaining([
        'outcome-driven-autonomy',
        'lean-testing',
        'access',
        'gate-profile',
        'content-language',
      ]),
    );
    expect(view.counts).toMatchObject({ inherited: 12, overridden: 0, project_only: 0, locked: 2 });
    expect(of(view, 'lean-testing')?.forge?.source).toContain('FB-570');
    expect(of(view, 'gate-profile')).toMatchObject({ authority: 'gates', state: 'inherited' });
  });
});

describe('BC-2: only a project admin changes an agreement, and never a locked one', () => {
  it('refuses a member without the grant by name, and writes nothing', async () => {
    const got = await api(w.member, 'PUT', path('/proportional-verification'), {
      ...BILLING,
      projectRevision: 0,
    });
    expect(got.status).toBe(403);
    expect(JSON.stringify(got.body)).toContain('project.admin');
    expect(of(await list(), 'proportional-verification')?.state).toBe('inherited');
  });

  it.each([
    ['a locked guarantee', '/access', 'AGREEMENT_LOCKED'],
    [
      'the gate profile, which the gates door writes',
      '/gate-profile',
      'AGREEMENT_AUTHORITY_ELSEWHERE',
    ],
  ])('refuses an override of %s by name', async (_, slug, code) => {
    const got = await api(w.admin, 'PUT', path(slug), { ...BILLING, projectRevision: 0 });
    expect(got.status, JSON.stringify(got.body)).toBe(422);
    expect(JSON.stringify(got.body)).toContain(code);
  });
});

describe('BC-2, BC-3, BC-6: a scoped override, its history, and the task it reaches', () => {
  it('overrides a default for billing work, recording the reason, the actor and the revision', async () => {
    const got = await api(w.admin, 'PUT', path('/proportional-verification'), {
      ...BILLING,
      projectRevision: 0,
    });
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const view = got.body as unknown as AgreementDetailView;
    expect(view).toMatchObject({
      state: 'overridden',
      project: { revision: 1, change: 'override', reason: BILLING.reason, baseRevision: 1 },
    });
    expect(view.project?.actor.id).toBeTruthy();
    expect(view.history.map((h) => `${h.layer}@${h.revision}`)).toEqual(['project@1', 'forge@1']);
  });

  it('refuses a write read at an older revision by name', async () => {
    const got = await api(w.admin, 'PUT', path('/proportional-verification'), {
      ...BILLING,
      projectRevision: 0,
    });
    expect(got.status).toBe(409);
    expect(JSON.stringify(got.body)).toContain('AGREEMENT_REVISION_STALE');
  });

  it.each([
    ['the billing issue', () => `?issue=${w.billingIssue}`, 'project@1'],
    ['a UI task', () => '?labels=ui', 'forge@1'],
  ])('hands %s the verification rule its labels name', async (_, query, revision) => {
    const view = await list(query());
    expect(of(view, 'proportional-verification')?.effective.revision).toBe(revision);
    expect(of(view, 'batch-delivery')?.effective.revision).toBe('forge@1');
  });

  it('carries the map to a fresh session, the default and the scoped change each named', async () => {
    const body = await servedCheckoutOrientation(w.projectId, w.slug);
    expect(body).toContain('## Working agreements');
    expect(body).toContain('When label billing: Billing changes run the billing checks');
    expect(body).toContain('**Lean testing**');
  });

  it('restores inheritance as a new revision, keeping the old one', async () => {
    const got = await api(w.admin, 'POST', path('/proportional-verification/restore'), {
      reason: 'The billing suite now runs in the scoped tests.',
      projectRevision: 1,
    });
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(of(got.body as unknown as AgreementsView, 'proportional-verification')?.state).toBe(
      'inherited',
    );
    const detail = (await api(w.member, 'GET', path('/proportional-verification')))
      .body as unknown as AgreementDetailView;
    expect(detail.history.map((h) => h.change)).toEqual(['restore', 'override', 'default']);
    const again = await api(w.admin, 'POST', path('/proportional-verification/restore'), {
      reason: 'twice',
      projectRevision: 2,
    });
    expect(JSON.stringify(again.body)).toContain('AGREEMENT_NOTHING_TO_RESTORE');
  });
});

describe('BC-2: an agreement of the project’s own', () => {
  it('needs a name, is project only once written, and is not current once retired', async () => {
    const write = {
      rule: 'Releases go out on weekdays only.',
      reason: 'Support is staffed on weekdays.',
    };
    const nameless = await api(w.admin, 'PUT', path('/release-window'), {
      ...write,
      projectRevision: 0,
    });
    expect(JSON.stringify(nameless.body)).toContain('AGREEMENT_NAME_REQUIRED');
    const added = await api(w.admin, 'PUT', path('/release-window'), {
      ...write,
      name: 'Release window',
      projectRevision: 0,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(of(await list(), 'release-window')?.state).toBe('project_only');
    const retired = await api(w.admin, 'POST', path('/release-window/restore'), {
      reason: 'Weekend support started.',
      projectRevision: 1,
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(of(await list(), 'release-window')).toBeUndefined();
    const gone = await api(w.member, 'GET', path('/release-window'));
    expect(gone.status).toBe(404);
    expect(JSON.stringify(gone.body)).toContain('retired');
  });
});

describe('BC-4: an agreement another configuration holds is read from it, one result', () => {
  it('shows the gates door’s change as the gate profile agreement, with that door’s reason', async () => {
    const gates = await api(w.admin, 'GET', `/api/projects/${w.projectId}/gates`);
    const put = await api(w.admin, 'PUT', `/api/projects/${w.projectId}/gates`, {
      baseRevision: gates.body.revision,
      profile: 'strict',
      overrides: {},
      reason: 'A customer asked for human sign-off.',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const got = of(await list(), 'gate-profile');
    expect(got).toMatchObject({ state: 'overridden', effective: { from: 'config' } });
    expect(got?.effective.rule).toContain('strict profile');
    expect(got?.project?.reason).toBe('A customer asked for human sign-off.');
  });
});
