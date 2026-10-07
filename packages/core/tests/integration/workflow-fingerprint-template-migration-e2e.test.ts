/**
 * Migration 0452, run by drizzle's own migrator over designs fingerprinted before the hash carried the
 * template and sorted its keys: a row whose stored fingerprint is the old rule's for its document is
 * re-hashed to exactly what `designFingerprint` computes today, with status, approved revision and
 * revision untouched, so an approved design is not read as changed since approval; a row whose
 * fingerprint is not the old rule's (the document changed after it was stamped) is left and named; a
 * row whose document names no template aborts the migration naming it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@forge/contracts/workflow-templates';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { designFingerprint, fingerprintShape } from '../../src/workflows/design.js';
import { readStoredWorkflow } from '../../src/workflows/schema.js';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0452_an_operational_flow_design_is_fingerprinted_with_its_template';
const OPERATIONAL = BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.id === 'operational-flow');
if (!OPERATIONAL) throw new Error('operational-flow is not a built-in template');

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  userId = randomUUID();
  const orgId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

/** An operational-flow@1 design that spells out its defaults, uses `_`/`-`/digit ids, and carries a return edge. */
function operationalDoc(flow: string): Record<string, unknown> {
  return {
    $schema: 'https://forge.sidcorp.co/schemas/workflow-v2.json',
    version: 2,
    project: projectId,
    flow,
    kind: 'flow',
    title: 'Discharge "follow-up" — né',
    summary: 'What happens when a patient is discharged\\ and a case opens.',
    template: { id: 'operational-flow', version: 1 },
    steps: [
      {
        id: 'his',
        does: 'The HIS says so.',
        after: [],
        node: { type: 'SOURCE', label: 'HIS', owner: 'IT', band: 'trigger' },
      },
      {
        id: 'discharged',
        title: 'Discharged',
        does: 'The event.',
        after: ['his'],
        node: {
          type: 'EVENT',
          label: 'Discharged',
          event: 'patient.discharged',
          payload: ['patient_id'],
        },
      },
      {
        id: 'rule_1',
        does: 'A rule.',
        after: ['discharged'],
        node: {
          type: 'RULE',
          label: 'Needs follow-up',
          conditions: [{ when: 'age > 65', result: 'yes' }],
        },
      },
      {
        id: 'rule',
        does: 'Another rule.',
        after: ['discharged'],
        node: { type: 'RULE', label: 'Other', band: 'feedback' },
      },
      {
        id: 'open-case',
        does: 'Open a case.',
        after: ['rule_1'],
        node: { type: 'CASE', label: 'Case' },
      },
      { id: 'untyped', does: 'No node.', after: ['open-case', 'his'] },
    ],
    edges: [
      { from: 'rule_1', to: 'open-case', kind: 'opens', label: 'Open' },
      { from: 'his', to: 'discharged', kind: 'emits' },
      { from: 'discharged', to: 'rule_1', kind: 'evaluates' },
      { from: 'discharged', to: 'rule' },
      {
        from: 'open-case',
        to: 'discharged',
        kind: 'feeds-back',
        reevaluates: 'the context',
        payload: ['x'],
        idempotency: 'by id',
        onFailure: 'retry',
      },
      { from: 'rule', to: 'rule_1', mapping: { b: '1', aaa: '2' } },
    ],
    writtenBy: {},
  };
}

/** The fingerprint the old rule stored: the writer's key order, and no template for operational-flow@1. */
function legacyFingerprint(doc: Record<string, unknown>): string {
  const parsed = readStoredWorkflow(doc);
  if (!parsed) throw new Error('fixture does not parse');
  const template = BUILTIN_WORKFLOW_TEMPLATES.find(
    (t) => t.id === parsed.template.id && t.version === parsed.template.version,
  );
  const { template: ref, ...shape } = fingerprintShape(parsed, template ?? null);
  const operational = ref.id === 'operational-flow' && ref.version === 1;
  const placed = operational ? shape : { ...shape, template: ref };
  return createHash('sha256').update(JSON.stringify(placed)).digest('hex');
}

const todayFingerprint = (doc: Record<string, unknown>): string => {
  const parsed = readStoredWorkflow(doc);
  if (!parsed) throw new Error('fixture does not parse');
  const template = BUILTIN_WORKFLOW_TEMPLATES.find(
    (t) => t.id === parsed.template.id && t.version === parsed.template.version,
  );
  return designFingerprint(parsed, template ?? null);
};

async function seed(
  flow: string,
  doc: Record<string, unknown>,
  status: string | null,
  approved: number | null,
  fingerprint: string | null,
): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, revision, document, design_status, design_fingerprint, approved_revision, written_by_user)
    VALUES (${id}, ${projectId}, ${flow}, 'flow', 3, ${m.sql.json(doc as never)}, ${status}, ${fingerprint}, ${approved}, ${userId})
  `;
  return id;
}

const rowOf = async (id: string) =>
  (
    await m.sql<
      Array<{
        design_status: string | null;
        design_fingerprint: string | null;
        approved_revision: number | null;
        revision: number;
      }>
    >`SELECT design_status, design_fingerprint, approved_revision, revision FROM project_workflows WHERE id = ${id}`
  )[0];

describe('a design fingerprinted before the hash carried its template and sorted its keys', () => {
  it('is re-hashed to what designFingerprint computes today and stays approved at its revision', async () => {
    const doc = operationalDoc('discharge');
    const old = legacyFingerprint(doc);
    const id = await seed('discharge', doc, 'approved', 3, old);
    const draft = operationalDoc('discharge-b');
    const proposed = await seed('discharge-b', draft, 'proposed', null, legacyFingerprint(draft));
    await m.migrate();

    expect(todayFingerprint(doc)).not.toBe(old);
    expect(await rowOf(id)).toEqual({
      design_status: 'approved',
      design_fingerprint: todayFingerprint(doc),
      approved_revision: 3,
      revision: 3,
    });
    expect(await rowOf(proposed)).toMatchObject({
      design_status: 'proposed',
      approved_revision: null,
      design_fingerprint: todayFingerprint(draft),
    });
  });

  it('is re-hashed in any built-in template, its template already in the old hash', async () => {
    const doc = { ...operationalDoc('lifecycle'), template: { id: 'state-machine', version: 1 } };
    const id = await seed('lifecycle', doc, 'approved', 3, legacyFingerprint(doc));
    await m.migrate();
    expect(await rowOf(id)).toMatchObject({
      design_fingerprint: todayFingerprint(doc),
      design_status: 'approved',
    });
  });

  it("is left as stored, and named, when its fingerprint is not the old rule's for its document", async () => {
    const drifted = operationalDoc('edited-after-approval');
    const approvedAt = legacyFingerprint({ ...drifted, title: 'What was approved' });
    const id = await seed('edited-after-approval', drifted, 'approved', 3, approvedAt);
    const ok = operationalDoc('still-fine');
    const fine = await seed('still-fine', ok, 'approved', 3, legacyFingerprint(ok));
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));

    expect(await rowOf(id)).toEqual({
      design_status: 'approved',
      design_fingerprint: approvedAt,
      approved_revision: 3,
      revision: 3,
    });
    expect((await rowOf(fine))?.design_fingerprint).toBe(todayFingerprint(ok));
    const named = notices.filter(
      (n) => n.includes('left drifted') && n.includes('edited-after-approval'),
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(`project ${projectId}`);
    expect(named[0]).toContain('revision 3');
    expect(notices.some((n) => n.includes('still-fine') && n.includes('left drifted'))).toBe(false);
    expect(notices.some((n) => n.includes('re-hashed 1') && n.includes('left drifted 1'))).toBe(
      true,
    );
  });

  it('aborts naming the row whose document names no template', async () => {
    const { template, ...bare } = operationalDoc('drawn-before-templates');
    void template;
    await seed('drawn-before-templates', bare, 'approved', 3, 'b'.repeat(64));
    await seed('fine', operationalDoc('fine'), null, null, null);
    let refusal = '';
    try {
      await m.migrate();
    } catch (e) {
      const err = e as Error & { cause?: { message?: string } };
      refusal = err.cause?.message ?? '';
    }
    expect(refusal).toMatch(/names no template.*drawn-before-templates \(project /);
    expect(refusal).not.toContain('fine');
    expect(
      (
        await m.sql`SELECT count(*)::int AS n FROM project_workflows WHERE design_fingerprint = ${'b'.repeat(64)}`
      )[0]?.n,
    ).toBe(1);
  });
});
