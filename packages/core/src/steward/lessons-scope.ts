// The requirements and designs in a lesson's scope, as the steward checks a lesson against them
// (REQ-50 BC-2, BC-5): an area lesson reads its area's requirements and the designs they link; a
// project or kind lesson reads the project's. Only requirements that are agreed or accepted, with
// their live criteria, and only approved designs: what a lesson may not contradict.

import type { LessonScope } from '@forge/contracts/lessons';
import { AGREED_STATUSES, requirementKey } from '@forge/contracts/requirements';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  requirementCriteria,
  requirements,
  requirementWorkflows,
} from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { markUntrusted } from '../lib/untrusted-text.js';

const REQUIREMENTS_READ = 20;
const CRITERIA_EACH = 8;
const DESIGNS_READ = 12;
const STEPS_EACH = 15;
const CLIP = 240;

const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text);

async function requirementsIn(projectId: string, scope: LessonScope) {
  return db
    .select({ id: requirements.id, seq: requirements.reqSeq, title: requirements.title })
    .from(requirements)
    .where(
      and(
        eq(requirements.projectId, projectId),
        inArray(requirements.status, [...AGREED_STATUSES]),
        scope.kind === 'area' ? eq(requirements.areaId, scope.areaId) : undefined,
      ),
    )
    .orderBy(desc(requirements.reqSeq))
    .limit(REQUIREMENTS_READ);
}

async function criteriaOf(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      requirementId: requirementCriteria.requirementId,
      code: requirementCriteria.code,
      body: requirementCriteria.body,
    })
    .from(requirementCriteria)
    .where(
      and(
        inArray(requirementCriteria.requirementId, [...ids]),
        isNull(requirementCriteria.retiredRevision),
      ),
    );
}

async function designsIn(projectId: string, scope: LessonScope, reqIds: readonly string[]) {
  const approved = and(
    eq(projectWorkflows.projectId, projectId),
    eq(projectWorkflows.designStatus, 'approved'),
  );
  if (scope.kind !== 'area') {
    return db
      .select({ flow: projectWorkflows.flow, document: projectWorkflows.document })
      .from(projectWorkflows)
      .where(approved)
      .limit(DESIGNS_READ);
  }
  if (reqIds.length === 0) return [];
  return db
    .selectDistinct({ flow: projectWorkflows.flow, document: projectWorkflows.document })
    .from(projectWorkflows)
    .innerJoin(requirementWorkflows, eq(requirementWorkflows.workflowId, projectWorkflows.id))
    .where(and(approved, inArray(requirementWorkflows.requirementId, [...reqIds])))
    .limit(DESIGNS_READ);
}

/** The words a design gives its steps: each step's label, title or name, as the design says it. */
function stepWords(document: unknown): string[] {
  const steps = (document as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, STEPS_EACH).flatMap((step) => {
    const s = step as Record<string, unknown>;
    const word = [s.label, s.title, s.name, s.id].find((v) => typeof v === 'string' && v.trim());
    return typeof word === 'string' ? [clip(word)] : [];
  });
}

/** The requirements and designs a lesson in `scope` may not contradict, as prompt text. */
export async function lessonScopeText(projectId: string, scope: LessonScope): Promise<string> {
  const reqs = await requirementsIn(projectId, scope);
  const ids = reqs.map((r) => r.id);
  const [criteria, designs] = await Promise.all([
    criteriaOf(ids),
    designsIn(projectId, scope, ids),
  ]);
  const reqText = reqs
    .map((r) => {
      const own = criteria
        .filter((c) => c.requirementId === r.id)
        .sort((a, b) => Number(a.code.slice(3)) - Number(b.code.slice(3)))
        .slice(0, CRITERIA_EACH)
        .map((c) => `  - ${c.code}: ${clip(c.body)}`);
      return [`- ${requirementKey(r.seq)} ${clip(r.title)}`, ...own].join('\n');
    })
    .join('\n');
  const designText = designs
    .map((d) => {
      const title = (d.document as { title?: unknown } | null)?.title;
      const steps = stepWords(d.document);
      return `- design ${d.flow}${typeof title === 'string' ? `: ${clip(title)}` : ''}${steps.length ? ` (steps: ${steps.join('; ')})` : ''}`;
    })
    .join('\n');
  return [
    `Requirements in its scope:\n${reqText ? markUntrusted(reqText, { source: 'the project requirements' }) : '(none)'}`,
    `Approved designs in its scope:\n${designText ? markUntrusted(designText, { source: 'the project designs' }) : '(none)'}`,
  ].join('\n\n');
}
