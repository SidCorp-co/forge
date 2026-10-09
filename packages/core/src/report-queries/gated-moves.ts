// gated-moves: over the last `days`, each gate's moves by how they stood (REQ-34 BC-8, BC-9): passed
// with the gate complete, refused by it, sent through by exception, and recorded before the gate,
// which is never counted as passed. Built over `lifecycle/gated-moves.ts:gatedMoveCounts`, the read
// the kernel's own records answer.

import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { z } from 'zod';
import { type GateCount, gatedMoveCounts } from '../lifecycle/index.js';
import { checkedFrame, defineAdapter } from './adapter.js';
import { periodPair } from './flow-fold.js';

/** The longest period: refused and passed moves of ended items are kept 90 days. */
export const GATED_DAYS_MAX = 90;

const descriptor = defineReportQuery({
  id: 'gated-moves',
  version: 1,
  title: 'Gated moves',
  params: z.object({
    days: z.number().int().min(1).max(GATED_DAYS_MAX).default(14),
  }),
  output: [
    { name: 'gate', type: 'string', label: 'Gate' },
    { name: 'gateId', type: 'string', label: 'Gate id' },
    { name: 'passed', type: 'number', unit: 'moves', label: 'Passed' },
    { name: 'refused', type: 'number', unit: 'moves', label: 'Refused' },
    { name: 'exception', type: 'number', unit: 'moves', label: 'By exception' },
    { name: 'noChecklist', type: 'number', unit: 'moves', label: 'No checklist' },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

/** One row per gate, in the order the gates are declared. */
export function gatedMovesFrame(counts: readonly GateCount[]): ReportFrame {
  const rows: Record<string, ReportCell>[] = counts.map((c) => ({
    gate: c.title,
    gateId: c.gate,
    passed: c.passed,
    refused: c.refused,
    exception: c.exception,
    noChecklist: c.noChecklist,
  }));
  return checkedFrame(descriptor.id, { fields: [...descriptor.output], rows });
}

export const gatedMoves = defineAdapter({
  descriptor,
  reads: ['lifecycle:gatedMoveCounts'],
  async run({ projectId, now }, p) {
    const { current } = periodPair(p.days, now ?? new Date());
    return gatedMovesFrame(await gatedMoveCounts(projectId, current));
  },
});
