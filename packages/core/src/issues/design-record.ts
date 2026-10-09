/**
 * An issue's design record (REQ-36 BC-1, BC-2, BC-13; Issue lifecycle r15 `design-check`): the
 * store, the write, and the one check every door asks before the work reaches build. The PATCH of
 * `workState.step` into build, test or release (`update-service.ts`), a claim from approved or
 * reopen (`apply-transition.ts:stepAfter`) and the move to approved (`transition-guards.ts`) all
 * read `designCheckOf`, so the web, REST and `forge-runner api` meet the same refusal. The rules are
 * `design-rules.ts`; the criteria and their classes are routed to their judge in
 * `criteria/verdict-record.ts`.
 */

import {
  type CriterionClass,
  type CriterionJudge,
  type DesignCheck,
  type IssueDesign,
  type IssueDesignRefusal,
  type IssueDesignView,
  JUDGE_OF_CLASS,
  type RecordDesignRequest,
} from '@forge/contracts/issue-design';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issueDesignCriteria, issueDesigns } from '../db/schema-issue-designs.js';
import { labels } from '../db/schema-labels.js';
import { RefusalError } from '../lib/refusal.js';
import { liveRows } from './criteria/store.js';
import { type DesignFacts, designCheck, designWriteRefusals } from './design-rules.js';
import { issueDisplayIds } from './display-ids.js';
import type { CatalogReading } from './pattern-rules.js';
import { catalogOf, patternFactsIn } from './patterns.js';
import { contractAboutRefusal } from './ports.js';

type Reader = Pick<Tx, 'select' | 'execute'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function moduleLabelsOf(
  executor: Reader,
  projectId: string,
): Promise<{ id: string; name: string }[]> {
  return executor
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')));
}

async function issueRefOf(executor: Reader, issueId: string): Promise<string> {
  return (await issueDisplayIds([issueId], executor as Tx)).get(issueId) ?? issueId;
}

/**
 * Everything the rules read about one issue's design, through `executor`. The catalog is read from
 * the project document, so a caller holding a row lock reads it before taking the lock and hands
 * it in (`transition-guards.ts` reads no second connection under its lock).
 */
async function readDesignFacts(
  executor: Reader,
  issue: { id: string; projectId: string },
  catalog?: CatalogReading,
): Promise<DesignFacts & { recorded: typeof issueDesigns.$inferSelect | null }> {
  const [recorded] = await executor
    .select()
    .from(issueDesigns)
    .where(eq(issueDesigns.issueId, issue.id))
    .limit(1);
  const lines = recorded
    ? await executor
        .select()
        .from(issueDesignCriteria)
        .where(eq(issueDesignCriteria.issueId, issue.id))
    : [];
  const criteria = (await liveRows(executor as Tx, issue.id)).sort((a, b) => a.n - b.n);
  return {
    issueRef: await issueRefOf(executor, issue.id),
    catalog: catalog ?? (await catalogOf(issue.projectId)),
    criteria,
    patterns: await patternFactsIn(executor, issue.id),
    design: recorded ? { modules: recorded.modules, lines } : null,
    moduleIds: new Set((await moduleLabelsOf(executor, issue.projectId)).map((m) => m.id)),
    recorded: recorded ?? null,
  };
}

/** The design check of the issue as it stands, read through the caller's transaction. */
export async function designCheckOf(
  executor: Reader,
  issue: { id: string; projectId: string },
  catalog?: CatalogReading,
): Promise<DesignCheck> {
  return designCheck(await readDesignFacts(executor, issue, catalog));
}

/** Refuses a move of the work step into build, test or release while the design does not pass. */
export async function assertDesignPasses(
  executor: Reader,
  issue: { id: string; projectId: string },
  catalog?: CatalogReading,
): Promise<void> {
  const check = await designCheckOf(executor, issue, catalog);
  if (check.passed) return;
  throw new RefusalError(
    [{ code: check.code, path: '/workState/step', detail: check.detail }],
    check.code,
  );
}

function viewOf(
  facts: Awaited<ReturnType<typeof readDesignFacts>>,
  modules: readonly { id: string; name: string }[],
): IssueDesignView | null {
  const recorded = facts.recorded;
  if (!recorded || !facts.design) return null;
  const byCriterion = new Map(facts.design.lines.map((l) => [l.criterionId, l]));
  const names = new Map(modules.map((m) => [m.id, m.name]));
  return {
    issue: facts.issueRef,
    revision: recorded.revision,
    criteria: facts.criteria.flatMap((c) => {
      const line = byCriterion.get(c.id);
      return line
        ? [
            {
              criterion: c.n,
              statement: c.statement,
              class: line.criterionClass,
              judge: JUDGE_OF_CLASS[line.criterionClass],
              pattern: line.pattern,
              proof: line.proof,
            },
          ]
        : [];
    }),
    modules: recorded.modules.map((id) => ({ id, name: names.get(id) ?? id })),
    contracts: recorded.contracts,
    recordedBy: recorded.recordedBy,
    recordedAt: recorded.recordedAt.toISOString(),
  };
}

/** The issue's design as the REST read answers it: the record, and the check a move into build meets. */
export async function issueDesignOf(issue: {
  id: string;
  projectId: string;
}): Promise<IssueDesign> {
  const facts = await readDesignFacts(db, issue);
  return {
    catalogDeclared: facts.catalog.kind === 'read',
    design: viewOf(facts, await moduleLabelsOf(db, issue.projectId)),
    check: designCheck(facts),
  };
}

/** The named modules as label ids, or a refusal per name that is no module of the project. */
function resolveModules(
  named: readonly string[],
  modules: readonly { id: string; name: string }[],
): { ids: string[]; refusals: IssueDesignRefusal[] } {
  const byId = new Map(modules.map((m) => [m.id, m.id]));
  const byName = new Map(modules.map((m) => [m.name, m.id]));
  const ids: string[] = [];
  const refusals: IssueDesignRefusal[] = [];
  for (const [at, name] of named.entries()) {
    const id = UUID.test(name) ? byId.get(name.toLowerCase()) : byName.get(name);
    if (id) {
      if (!ids.includes(id)) ids.push(id);
      continue;
    }
    refusals.push({
      code: 'DESIGN_MODULE_UNKNOWN',
      path: `/modules/${at}`,
      detail: `\`${name}\` is not a module of this project; name a module label by its name or id (GET /api/projects/:id/modules/rollup lists them)`,
    });
  }
  return { ids, refusals };
}

async function contractRefusals(
  projectId: string,
  contracts: readonly string[],
): Promise<IssueDesignRefusal[]> {
  const out: IssueDesignRefusal[] = [];
  for (const [at, contract] of contracts.entries()) {
    const why = await contractAboutRefusal(projectId, contract);
    if (why) out.push({ code: 'DESIGN_CONTRACT_UNKNOWN', path: `/contracts/${at}`, detail: why });
  }
  return out;
}

type Outcome = { ok: true; value: IssueDesign } | { ok: false; refusals: IssueDesignRefusal[] };

/**
 * Records the issue's design, replacing any earlier one whole and bumping its revision. Locks the
 * issue row first, so a step move or another write waits for it and reads the design it leaves.
 */
export async function recordDesign(args: {
  issue: { id: string; projectId: string; status: string };
  body: RecordDesignRequest;
  actor: { userId: string; agency: ActorAgency | null };
}): Promise<Outcome> {
  const { issue, body, actor } = args;
  if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status)) {
    const ref = await issueRefOf(db, issue.id);
    return {
      ok: false,
      refusals: [
        {
          code: 'DESIGN_ISSUE_FINISHED',
          path: '',
          detail: `${ref} is ${issue.status}; a finished issue records no design`,
        },
      ],
    };
  }
  const catalog = await catalogOf(issue.projectId);
  const contracts = [...new Set(body.contracts)];
  const unknownContracts = await contractRefusals(issue.projectId, contracts);
  const refused = await db.transaction(async (tx): Promise<IssueDesignRefusal[]> => {
    await tx.execute(sql`SELECT 1 FROM issues WHERE id = ${issue.id} FOR UPDATE`);
    const facts = await readDesignFacts(tx, issue, catalog);
    const modules = await moduleLabelsOf(tx, issue.projectId);
    const resolved = resolveModules(body.modules, modules);
    const refusals = [
      ...designWriteRefusals(body, facts),
      ...resolved.refusals,
      ...unknownContracts,
    ];
    if (refusals.length > 0) return refusals;
    const revision = (facts.recorded?.revision ?? 0) + 1;
    const values = {
      projectId: issue.projectId,
      revision,
      modules: resolved.ids,
      contracts,
      recordedBy: actor.userId,
      recordedAgency: actor.agency,
      recordedAt: new Date(),
    };
    await tx
      .insert(issueDesigns)
      .values({ issueId: issue.id, ...values })
      .onConflictDoUpdate({ target: issueDesigns.issueId, set: values });
    await tx.delete(issueDesignCriteria).where(eq(issueDesignCriteria.issueId, issue.id));
    const idOf = new Map(facts.criteria.map((c) => [c.n, c.id]));
    await tx.insert(issueDesignCriteria).values(
      body.criteria.map((line) => ({
        criterionId: idOf.get(line.criterion) as string,
        issueId: issue.id,
        criterionClass: line.class,
        pattern: line.pattern,
        proof: line.proof,
      })),
    );
    return [];
  });
  if (refused.length > 0) return { ok: false, refusals: refused };
  return { ok: true, value: await issueDesignOf(issue) };
}

/** Each classed criterion's class and the judge it routes to, by criterion id; an unclassed one is absent. */
export async function criterionRoutesOf(
  criterionIds: readonly string[],
  executor: Pick<Tx, 'select'> = db,
): Promise<Map<string, { class: CriterionClass; judge: CriterionJudge }>> {
  if (criterionIds.length === 0) return new Map();
  const rows = await executor
    .select({
      criterionId: issueDesignCriteria.criterionId,
      criterionClass: issueDesignCriteria.criterionClass,
    })
    .from(issueDesignCriteria)
    .where(inArray(issueDesignCriteria.criterionId, [...criterionIds]));
  return new Map(
    rows.map((r) => [
      r.criterionId,
      { class: r.criterionClass, judge: JUDGE_OF_CLASS[r.criterionClass] },
    ]),
  );
}
