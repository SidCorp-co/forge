/**
 * A requirement's delivery moves, made by rule where no person gate asks them (owner 2026-11-08, D1;
 * ISS-616). On a project whose policy gives `requirement.accept` to the master (`who-owes`: its accept
 * gate is off), nothing asks anyone to move a requirement:
 * - agreed → in_delivery once one of its carrying issues has started;
 * - in_delivery → delivered once every criterion of its current revision passes;
 * - delivered → accepted at once, named as accepted by rule with its passing count.
 * Each goes through the same door and guards a person's move does (`requirements/acceptance.ts`),
 * as the project's steward account, the agent Forge acts as on the project; a guard that refuses is
 * logged by name and the requirement keeps its standing, which says what holds it. Under an accept
 * gate nothing here moves: a person still makes each move, as before. A read never moves one: this
 * sweep is the only writer.
 */

import { whoOwes } from '@forge/contracts/who-owes';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { logger } from '../lib/logger.js';
import { readOwedPolicy } from '../project-config/index.js';
import {
  acceptDelivery,
  moveDelivery,
  repinRequirement,
  requirementStandingsOf,
} from '../requirements/index.js';
import { stewardAccountOf } from './account.js';

export interface RuleMovesResult {
  inDelivery: number;
  delivered: number;
  accepted: number;
  /** Re-pinned to an approved design or contract no traced step of which changed (D3). */
  repinned: number;
  /** Moves a guard refused; each is logged with its codes. */
  refused: number;
}

type Standing = Awaited<ReturnType<typeof requirementStandingsOf>>[number]['standing'];

/** Every criterion of the shown revision passes, and there is at least one. */
export const allPassing = (s: Pick<Standing, 'delivery'>): boolean => {
  const c = s.delivery.criteriaCoverage;
  return c.criteria > 0 && c.passing === c.criteria;
};

/** The move a requirement is owed by rule now, read off its standing; null where none is. */
export function ruleMoveOf(
  s: Pick<Standing, 'state' | 'delivery'>,
): 'in_delivery' | 'delivered' | 'accepted' | null {
  if (s.state === 'agreed' && s.delivery.startedIssues > 0) return 'in_delivery';
  if (s.state === 'in_delivery' && allPassing(s)) return 'delivered';
  if (s.state === 'delivered' && allPassing(s)) return 'accepted';
  return null;
}

/**
 * A re-pin owed by rule (D3): the standing names the pin as its wait, which `turnOf` reads only where
 * no step a live criterion traces changed, and where no gate asks a person (Forge's wait).
 */
export const repinOwed = (s: Pick<Standing, 'waitingOn' | 'facts'>): boolean =>
  s.waitingOn.says.rule.key === 'requirements.rule.byRule' &&
  s.facts.stalePins.length + s.facts.staleContractPins.length > 0 &&
  !DELIVERY_MOVES.has((s.waitingOn.says.act.vars?.move as { key?: string } | undefined)?.key ?? '');

/** The acts a rule wait names for a delivery move rather than a re-pin. */
const DELIVERY_MOVES: ReadonlySet<string> = new Set([
  'standing.act.startDelivery',
  'standing.act.markDelivered',
  'standing.act.acceptByRule',
]);

/** What a rule move records as its reason: the rule, and the counts it read. */
export function ruleReason(
  to: 'in_delivery' | 'delivered' | 'accepted',
  s: Pick<Standing, 'delivery'>,
): string {
  const c = s.delivery.criteriaCoverage;
  const counts = `${c.passing}/${c.criteria} criteria passing`;
  if (to === 'in_delivery') {
    return `by rule: ${s.delivery.startedIssues} of its issues started, and no person gate asks this move`;
  }
  if (to === 'delivered') return `by rule: ${counts} on the current revision`;
  return `accepted by rule: no person accept gate on this project, ${counts}`;
}

export async function sweepRequirementRuleMoves(): Promise<RuleMovesResult> {
  const result: RuleMovesResult = {
    inDelivery: 0,
    delivered: 0,
    accepted: 0,
    repinned: 0,
    refused: 0,
  };
  const projects = rowsOf<{ project_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT r.project_id FROM requirements r JOIN projects p ON p.id = r.project_id
       WHERE r.status IN ('agreed', 'in_delivery', 'delivered') AND p.archived_at IS NULL`),
  );
  for (const { project_id: projectId } of projects) {
    try {
      if (whoOwes('requirement.accept', await readOwedPolicy(projectId)).by !== 'master') continue;
      await moveProject(projectId, result);
    } catch (err) {
      logger.error({ err, projectId }, 'requirement rule moves: the project was not swept');
    }
  }
  if (Object.values(result).some((n) => n > 0)) logger.info(result, 'requirement rule moves: made');
  return result;
}

async function moveProject(projectId: string, result: RuleMovesResult): Promise<void> {
  let actor: { userId: string; agency: 'agent' } | null = null;
  for (const r of await requirementStandingsOf(projectId)) {
    let standing: Standing = r.standing;
    if (repinOwed(standing)) {
      actor ??= { userId: await stewardAccountOf(projectId), agency: 'agent' };
      const out = await repinRequirement({
        projectId,
        ref: r.key,
        actor,
        revision: standing.shownRevision ?? 0,
        reason: 'by rule: the approved design or contract changed no step a live criterion traces',
        byRule: true,
      });
      if (!out.ok) {
        result.refused += 1;
        logger.warn(
          { projectId, requirement: r.key, refusals: out.refusals.map((f) => f.code) },
          'requirement rule moves: a guard refused the re-pin',
        );
        continue;
      }
      result.repinned += 1;
      standing = out.requirement.standing;
    }
    // one requirement may take every step in one sweep: each move reads the standing it leaves
    for (let to = ruleMoveOf(standing); to !== null; to = ruleMoveOf(standing)) {
      actor ??= { userId: await stewardAccountOf(projectId), agency: 'agent' };
      const reason = ruleReason(to, standing);
      const ref = r.key;
      const out =
        to === 'accepted'
          ? await acceptDelivery({
              projectId,
              ref,
              actor,
              revision: standing.shownRevision ?? 0,
              reason,
              byRule: true,
            })
          : await moveDelivery({ projectId, ref, actor, to, reason, byRule: true });
      if (!out.ok) {
        result.refused += 1;
        logger.warn(
          { projectId, requirement: r.key, to, refusals: out.refusals.map((f) => f.code) },
          'requirement rule moves: a guard refused the move; its standing names what holds it',
        );
        break;
      }
      if (to === 'in_delivery') result.inDelivery += 1;
      else if (to === 'delivered') result.delivered += 1;
      else result.accepted += 1;
      standing = out.requirement.standing;
    }
  }
}
