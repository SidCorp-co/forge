/**
 * Migration 0452, run by drizzle's own migrator over operational-flow@1 designs fingerprinted before the
 * hash carried the template: each such row is re-hashed to exactly what `designFingerprint` computes
 * today from its stored document, with its status, approved revision and revision untouched, so an
 * approved design is not read as changed since approval; another template's row is left alone; a row
 * whose document names no template aborts the migration naming it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@forge/contracts/workflow-templates';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { designFingerprint } from '../../src/workflows/design.js';
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

/** The fingerprint the old rule stored: the shape with no template in it. */
function legacyFingerprint(doc: Record<string, unknown>): string {
  const spy = JSON.stringify;
  let shape = '';
  JSON.stringify = ((v: unknown, ...rest: never[]) => {
    const s = spy(v, ...rest);
    if (v && typeof v === 'object' && 'steps' in v && 'edges' in v) shape = s;
    return s;
  }) as typeof JSON.stringify;
  try {
    const parsed = readStoredWorkflow(doc);
    if (!parsed) throw new Error('fixture does not parse');
    designFingerprint(parsed, OPERATIONAL ?? null);
  } finally {
    JSON.stringify = spy;
  }
  const template = JSON.stringify(doc.template);
  expect(shape).toContain(`,"template":${template}`);
  return createHash('sha256')
    .update(shape.replace(`,"template":${template}`, ''))
    .digest('hex');
}

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

describe('an operational-flow@1 design fingerprinted before the hash carried its template', () => {
  it('is re-hashed to what designFingerprint computes today and stays approved at its revision', async () => {
    const doc = operationalDoc('discharge');
    const old = legacyFingerprint(doc);
    const id = await seed('discharge', doc, 'approved', 3, old);
    const proposed = await seed(
      'discharge-b',
      operationalDoc('discharge-b'),
      'proposed',
      null,
      legacyFingerprint(operationalDoc('discharge-b')),
    );
    const bare = await seed('discharge-c', operationalDoc('discharge-c'), null, null, null);
    await m.migrate();

    const stored = readStoredWorkflow(doc);
    if (!stored) throw new Error('fixture does not parse');
    const now = designFingerprint(stored, OPERATIONAL ?? null);
    expect(now).not.toBe(old);
    expect(await rowOf(id)).toEqual({
      design_status: 'approved',
      design_fingerprint: now,
      approved_revision: 3,
      revision: 3,
    });
    const b = readStoredWorkflow(operationalDoc('discharge-b'));
    if (!b) throw new Error('fixture does not parse');
    expect(await rowOf(proposed)).toMatchObject({
      design_status: 'proposed',
      approved_revision: null,
      design_fingerprint: designFingerprint(b, OPERATIONAL ?? null),
    });
    expect((await rowOf(bare))?.design_fingerprint).toBe(
      designFingerprint({ ...b, flow: 'discharge-c' }, OPERATIONAL ?? null),
    );
  });

  it('leaves a design in another template as it was stored', async () => {
    const doc = { ...operationalDoc('lifecycle'), template: { id: 'state-machine', version: 1 } };
    const id = await seed('lifecycle', doc, 'approved', 3, 'a'.repeat(64));
    await m.migrate();
    expect(await rowOf(id)).toMatchObject({
      design_fingerprint: 'a'.repeat(64),
      design_status: 'approved',
    });
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
