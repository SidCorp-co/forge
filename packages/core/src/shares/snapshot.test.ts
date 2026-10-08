import { randomUUID } from 'node:crypto';
import type { ReportDocument } from '@forge/contracts/report-templates';
import { describe, expect, it } from 'vitest';
import { isRefusal, refusalCodeOf } from '../lib/refusal.js';
import { shareSnapshot } from './snapshot.js';

// What a share freezes: secrets and email addresses never survive into a snapshot, a link share
// passes the project's data policy, and a document that is not wholly this project's is refused.

const PROJECT = randomUUID();
const SECRET = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const EMAIL = 'ana.nguyen@example.com';

function plantedDocument(projectId = PROJECT): ReportDocument {
  const frame = {
    fields: [
      { name: 'requirement', type: 'ref' as const, label: 'Requirement' },
      { name: 'note', type: 'string' as const, label: 'Note' },
      { name: 'proven', type: 'number' as const, label: 'Proven' },
    ],
    rows: [
      { requirement: 'REQ-1', note: `ask ${EMAIL}, deploy key ${SECRET}`, proven: 3 },
      { requirement: 'REQ-2', note: 'call 0912 345 678', proven: 1 },
    ],
  };
  return {
    templateId: 'progress',
    version: 1,
    params: {},
    runs: [
      {
        runId: 'run-1',
        queryId: 'progress-by-requirement',
        version: 1,
        params: {},
        projectId,
        actor: { kind: 'human', id: randomUUID() },
        asOf: '2026-10-08T09:00:00.000Z',
        frame,
      },
    ],
    blocks: [
      {
        kind: 'table',
        v: 1,
        title: `Progress, from ${EMAIL}`,
        columns: ['requirement', 'note', 'proven'],
        source: { runId: 'run-1' },
        frame,
      },
    ],
    narrative: {
      summary: `Two requirements; the token ${SECRET} was rotated by ${EMAIL}.`,
      risks: 'None named.',
      recommendations: `Write to ${EMAIL}.`,
    },
  };
}

const snap = (over: Partial<Parameters<typeof shareSnapshot>[0]> = {}) =>
  shareSnapshot({
    document: plantedDocument(),
    projectId: PROJECT,
    audience: 'members',
    level: 'off',
    ...over,
  });

const refusedAs = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    expect(isRefusal(err)).toBe(true);
    return refusalCodeOf(err);
  }
};

describe('a share snapshot', () => {
  it('carries no planted secret or email address, wherever it sat, and keeps the figures', () => {
    for (const audience of ['members', 'link'] as const) {
      const out = snap({ audience });
      const text = JSON.stringify(out);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(EMAIL);
      expect(text).toContain('[email]');
      expect(text).toContain('[Filtered]');
      expect(out.runs[0]?.frame.rows.map((r) => r.proven)).toEqual([3, 1]);
      expect(out.blocks[0]?.kind).toBe('table');
    }
  });

  it('refuses a link share of a no_egress project by name, and lets its members share', () => {
    expect(refusedAs(() => snap({ audience: 'link', level: 'no_egress' }))).toBe(
      'SHARE_EGRESS_FORBIDDEN',
    );
    expect(snap({ audience: 'members', level: 'no_egress' }).templateId).toBe('progress');
  });

  it('scrubs personal data from a link share of a project at redact', () => {
    const text = JSON.stringify(snap({ audience: 'link', level: 'redact' }));
    expect(text).not.toContain('0912 345 678');
    expect(JSON.stringify(snap({ audience: 'members', level: 'redact' }))).toContain(
      '0912 345 678',
    );
  });

  it("refuses a document holding another project's run", () => {
    expect(refusedAs(() => snap({ document: plantedDocument(randomUUID()) }))).toBe(
      'SHARE_SUBJECT_FOREIGN',
    );
  });

  it('refuses something that is not a report document, naming the field', () => {
    const doc = { ...plantedDocument(), blocks: [{ kind: 'pie' }] };
    let detail = '';
    try {
      snap({ document: doc });
    } catch (err) {
      expect(refusalCodeOf(err)).toBe('SHARE_SNAPSHOT_INVALID');
      detail = (err as Error).message;
    }
    expect(detail).toContain('blocks.0');
  });
});
