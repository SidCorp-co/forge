// criteria-coverage: each business criterion of each requirement, its proof and the issues that
// trace to it. Built over `listRequirementsAs`, whose `standing.coverage` is the one answer the
// Requirements screen and a release's `completes` already read.

import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import type { RequirementSummary } from '@forge/contracts/requirements';
import { z } from 'zod';
import { listRequirementsAs } from '../requirements/index.js';
import { checkedFrame, defineAdapter } from './adapter.js';

const REQUIREMENT_KEY = /^REQ-[1-9]\d{0,8}$/;

const descriptor = defineReportQuery({
  id: 'criteria-coverage',
  version: 1,
  title: 'Criteria coverage',
  params: z.object({
    requirement: z.string().regex(REQUIREMENT_KEY, 'a requirement key like REQ-12').optional(),
  }),
  output: [
    { name: 'requirement', type: 'ref', label: 'Requirement' },
    { name: 'title', type: 'string', label: 'Requirement title' },
    { name: 'criterion', type: 'string', label: 'Criterion' },
    { name: 'body', type: 'string', label: 'What must hold' },
    { name: 'verdict', type: 'status', label: 'Verdict' },
    { name: 'issues', type: 'string', label: 'Traced by' },
    { name: 'issueCount', type: 'number', unit: 'issues', label: 'Issues' },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

const numberOf = (key: string) => Number(key.replace(/\D/g, ''));

/** One row per criterion, in requirement then criterion order; `verdict` is the read's own word. */
export function criteriaCoverageFrame(
  list: readonly Pick<RequirementSummary, 'key' | 'title' | 'standing'>[],
  only?: string,
): ReportFrame {
  const rows: Record<string, ReportCell>[] = [];
  const chosen = only === undefined ? list : list.filter((r) => r.key === only);
  for (const r of [...chosen].sort((a, b) => numberOf(a.key) - numberOf(b.key))) {
    for (const c of [...r.standing.coverage].sort((a, b) => numberOf(a.code) - numberOf(b.code))) {
      rows.push({
        requirement: r.key,
        title: r.title,
        criterion: c.code,
        body: c.body,
        verdict: c.verdict,
        issues: c.issues.map((i) => i.displayId).join(', '),
        issueCount: c.issues.length,
      });
    }
  }
  return checkedFrame(descriptor.id, { fields: [...descriptor.output], rows });
}

export const criteriaCoverage = defineAdapter({
  descriptor,
  reads: ['requirements:listRequirementsAs'],
  async run({ projectId, viewer }, params) {
    const list = await listRequirementsAs(viewer, projectId);
    if (params.requirement !== undefined && !list.some((r) => r.key === params.requirement)) {
      throw new Error(
        `report query "criteria-coverage": project ${projectId} holds no requirement ${params.requirement}; params.requirement is a key like REQ-12 of this project`,
      );
    }
    return criteriaCoverageFrame(list, params.requirement);
  },
});
