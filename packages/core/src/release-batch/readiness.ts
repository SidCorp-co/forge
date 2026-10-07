import type { ReleaseGateView } from '@forge/contracts/releases';
import { selectAllSlugsFromKnowledge } from '../knowledge/index.js';
import type { DeploymentTrigger, Promotion } from '../project-config/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import { missingProjectKnowledge } from '../projects/index.js';
import {
  collectReleaseBlockers,
  type ReleaseBlocker,
  type ReleaseWarning,
  releaseBlockerSentence,
} from './blockers.js';
import { releaseRunnerLabelOf } from './channel.js';
import type { ReleaseRollback, VerifySource } from './plan.js';
import { gateViews } from './release-gates.js';
import { readWeighingNow } from './runtime-weighing.js';
import { readServingNow } from './serving-reading.js';

type ReleaseGapKey = string;

type ReleaseDeclarationRead = Awaited<ReturnType<typeof collectReleaseBlockers>>['declaration'];
type ReleaseChannelRead = NonNullable<
  Awaited<ReturnType<typeof collectReleaseBlockers>>['channels']
>[number];
interface ProjectRow {
  repository: string | null;
}

interface ReleaseProduction {
  environment: string;
  /** The branch it deploys from where a promotion crosses into it; null where none does. */
  deploysFrom: string | null;
  bindingId: string;
  trigger: DeploymentTrigger;
}

interface ReleaseReadiness {
  hasReleaseGate: boolean;
  /** Where work lands (`source.git.defaultBranch`); null with no git source or no reading. */
  defaultBranch: string | null;
  production: ReleaseProduction | null;
  promotions: Promotion[];
  targetUndeclared: boolean;
  targetUndeclaredReason: string | null;
  /** The production deploy binding's provider; empty when the project is not gated. */
  providers: string[];
  releaseRunnerLabel: string | null;
  /** Verbatim rollback declaration; `null` when the channel performs it or none is declared. */
  rollback: string | null;
  /** How the declaration was read. `null` means abort-and-comment on failure. */
  rollbackMode: ReleaseRollback['kind'] | null;
  hasVerify: boolean;
  /** Where the production environment's probes came from, in the same order as `providers`. */
  verifySources: VerifySource[];
  /** False where the declaration could not be READ: nothing here is then a reading. */
  declarationRead: boolean;
  /** The same, for `providers`, the rollback, `hasVerify` and the label. */
  channelsRead: boolean;
  /** Everything still undeclared. Empty means settings has nothing to say. */
  gaps: ReleaseGapKey[];
  /**
   * Every reason a release would be refused RIGHT NOW, in the order the create
   * door refuses in — the declarations, and also the roster and the fleet, which
   * `gaps` never looked at. Empty here means a create over this roster succeeds (ISS-1127).
   */
  blockers: ReleaseBlocker[];
  /** What will change how the release runs without stopping it. */
  warnings: ReleaseWarning[];
  /** `blockers` then `warnings` as a person reads them: a title, a sentence and who owes the act,
   *  the same reading a release's own page carries, so settings words a reason no differently. */
  gates: ReleaseGateView[];
}

export async function loadReleaseReadiness(projectId: string): Promise<ReleaseReadiness | null> {
  // ONE pass: the enumerator guards these reads and a second copy would throw away its report
  // (ISS-1127). The reading is HERE because the enumerator reaches no network (ISS-1286).
  const serving = await readServingNow(projectId).catch(() => undefined);
  const weighing = serving
    ? await readWeighingNow(projectId, serving).catch((err: unknown) =>
        err instanceof Error ? err.message : String(err),
      )
    : undefined;
  const report = await collectReleaseBlockers(projectId, { serving, weighing });
  if (!report.projectExists) return null;
  const decl = report.declaration;
  const channels = report.channels ?? [];
  const blockers = [...report.blockers];

  const row = await guarded('repository', blockers, async () => ({
    repository: (await readDeclaredSource(projectId)).repository,
  }));
  const held = await guarded('knowledge', blockers, () => selectAllSlugsFromKnowledge(projectId));

  const gaps = declarationGaps({ decl, channels: report.channels, row, held });
  const first = channels[0] ?? null;
  const releaseRunnerLabel = releaseRunnerLabelOf(channels);

  const gated = decl?.kind === 'gated' ? decl : null;
  const deployment = gated?.production.declaration.deployment;
  return {
    declarationRead: decl !== null,
    channelsRead: report.channels !== null,
    hasReleaseGate: gated !== null,
    defaultBranch: decl && decl.kind !== 'undeclared-target' ? decl.defaultBranch : null,
    production:
      gated && deployment && 'trigger' in deployment
        ? {
            environment: gated.production.name,
            deploysFrom: gated.deploysFrom,
            bindingId: gated.binding.binding.id,
            trigger: deployment.trigger,
          }
        : null,
    promotions: gated?.path.crossing ? [gated.path.crossing] : [],
    targetUndeclared: decl?.kind === 'undeclared-target',
    targetUndeclaredReason: decl?.kind === 'undeclared-target' ? decl.reason : null,
    providers: channels.map((c) => c.provider),
    releaseRunnerLabel,
    rollback: first?.rollback && 'text' in first.rollback ? first.rollback.text : null,
    rollbackMode: first?.rollback?.kind ?? null,
    hasVerify: channels.length > 0 && channels.every((c) => c.verify !== null),
    verifySources: channels.map((c) => c.verifySource),
    gaps,
    blockers,
    warnings: report.warnings,
    gates: gateViews(blockers, report.warnings),
  };
}

/** A read this answer needs, and the blocker that stands in for it when it fails. */
async function guarded<T>(
  check: string,
  out: ReleaseBlocker[],
  read: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    out.push({
      code: 'RELEASE_CHECK_UNEVALUATED',
      message: releaseBlockerSentence('RELEASE_CHECK_UNEVALUATED', { check, detail }),
      details: { check, detail },
      evaluated: false,
    });
    return undefined;
  }
}

/** In every field, the unset value means the read FAILED — never an absence. */
interface GapInput {
  decl: ReleaseDeclarationRead;
  channels: ReleaseChannelRead[] | null;
  row: ProjectRow | null | undefined;
  held: string[] | undefined;
}

/** What settings still has to say. Unchanged by ISS-1127, and still not the blocker list. */
function declarationGaps(input: GapInput): ReleaseGapKey[] {
  const { decl, channels, row, held } = input;
  const gaps: ReleaseGapKey[] = [];
  // A gap is an ABSENCE somebody can act on, never a read nobody managed to
  // make (ISS-1127).
  if (row !== undefined && held !== undefined) {
    const declarations = {
      repository: row?.repository ?? null,
      production: decl?.kind === 'gated' ? decl.production.name : null,
    };
    gaps.push(...missingProjectKnowledge(declarations, held).map((o) => o.slug));
  }
  if (decl?.kind === 'undeclared-target') gaps.push('release-target');
  if (decl?.kind !== 'gated' || channels === null) return gaps;

  if (channels.some((c) => !c.verify)) gaps.push('verify-probes');
  if (channels.some((c) => !c.rollback)) gaps.push('rollback');
  else if (channels.some((c) => c.rollback?.kind === 'unrepresentable'))
    gaps.push('rollback-prose');
  return gaps;
}
