/**
 * The system prompt a job on an issue runs under: the pipeline preamble, then the artifact,
 * contract and pinned-contract blocks its issue reaches. `prepare-claimed-job.ts` and the prompt
 * preview (`prompt/routes.ts`) both call `buildJobSystemPrompt`, so what a preview shows is what a
 * claimed job is given. Nothing here writes; recording the loads on a session is prepare's.
 */

import type { ContentLanguageRecord } from '@forge/contracts/content-language';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, issues, type JobType, labels } from '../db/schema.js';
import {
  type LoadedContract,
  pathsNamedIn,
  renderContractContext,
} from '../ecosystem/contract/run-context.js';
import { loadContractContext } from '../ecosystem/contract/run-context-service.js';
import { buildPipelinePreambleStructured, type PreambleBlock } from '../lib/chat-preamble.js';
import { dataPolicyOf, type EgressSurface, egressText, withheldAt } from '../lib/data-egress.js';
import { estimateTokens } from '../lib/token-estimator.js';
import { logger } from '../logger.js';
import type { DispatchState } from '../project-config/dispatch-policy.js';
import {
  type LoadedPinnedContract,
  loadPinnedContracts,
  PinnedContractError,
  renderPinnedContracts,
} from '../workflows/pinned-contracts.js';
import {
  type LoadedRequirement,
  RequirementContextError,
  renderIssueMockups,
} from '../workflows/requirement-context.js';
import {
  ArtifactContextError,
  type LoadedArtifact,
  renderArtifactContext,
} from '../workflows/run-context.js';
import {
  issueMockupsOf,
  loadArtifactContext,
  loadRequirementContext,
} from '../workflows/run-context-service.js';
import { SKILL_MAINTENANCE_LABEL, withSkillMaintenanceCarveout } from './job-policy.js';

/** A context the job's issue reaches that cannot be given; the job is refused, never built blind. */
export class JobContextRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface JobSystemPrompt {
  systemPrompt: string;
  blocks: PreambleBlock[];
  contentLanguage: ContentLanguageRecord | undefined;
  deniedTools: string[];
  designs: LoadedArtifact[];
  requirement: LoadedRequirement | null;
  contracts: LoadedContract[];
  pinnedContracts: LoadedPinnedContract[];
}

type IssueText = {
  description: string | null;
  plan: string | null;
  acceptanceCriteria: string | null;
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Give a `code`/`fix` job on a skill-maintenance issue its skill-write tools back; best-effort. */
async function carvedDeniedTools(
  projectId: string,
  issueId: string | null,
  step: JobType,
  deniedTools: string[],
): Promise<string[]> {
  if (!issueId || (step !== 'code' && step !== 'fix')) return deniedTools;
  try {
    const [labelRow] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.projectId, projectId), eq(labels.name, SKILL_MAINTENANCE_LABEL)))
      .limit(1);
    let hasSkillMaintenanceLabel = false;
    if (labelRow) {
      const [issueLabelRow] = await db
        .select({ issueId: issueLabels.issueId })
        .from(issueLabels)
        .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, labelRow.id)))
        .limit(1);
      hasSkillMaintenanceLabel = Boolean(issueLabelRow);
    }
    const carved = withSkillMaintenanceCarveout(deniedTools, {
      hasSkillMaintenanceLabel,
      jobType: step,
    });
    if (carved.length < deniedTools.length) {
      logger.info(
        { issueId, jobType: step, removed: deniedTools.length - carved.length },
        'job prompt: skill-maintenance carve-out unblocked skill-write tools',
      );
    }
    return carved;
  } catch (err) {
    logger.warn(
      { err, issueId, type: step },
      'job prompt: skill-maintenance label lookup failed, building without carve-out',
    );
    return deniedTools;
  }
}

// cm:why a run is given the contracts its issue's named paths reach before it starts, since the paths it will change are not known yet; it asks forge_ecosystem action=context for paths it finds later
async function contractsNamedBy(
  projectId: string,
  issue: IssueText | undefined,
  subject: string,
): Promise<LoadedContract[]> {
  if (!issue) return [];
  const text = [issue.description, issue.plan, issue.acceptanceCriteria].filter(Boolean).join('\n');
  try {
    return await loadContractContext(projectId, pathsNamedIn(text));
  } catch (err) {
    // cm:guard a run whose contract context cannot be read is refused, never prepared without it — it would edit a call site blind (owner, 2026-10-02)
    throw new JobContextRefused(
      'CONTRACT_CONTEXT_UNLOADABLE',
      `CONTRACT_CONTEXT_UNLOADABLE: ${subject}: the contracts its issue's paths reach could not be read (${errText(err)})`,
      { cause: err },
    );
  }
}

// A job on an issue that delivers a requirement is given every contract version the requirement's
// latest baseline pins, the provider's and the consumer's issue alike (requirement-to-delivery,
// edge delivery -> build); a pinned version that cannot be given refuses the job by name.
async function contractsPinnedFor(
  requirement: LoadedRequirement | null,
  subject: string,
): Promise<LoadedPinnedContract[]> {
  if (!requirement) return [];
  try {
    return await loadPinnedContracts(requirement.key, requirement.pins);
  } catch (err) {
    const code = err instanceof PinnedContractError ? err.code : 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw new JobContextRefused(
      code,
      `${code}: ${subject}: the contract versions its requirement pins could not be given (${errText(err)})`,
      { cause: err },
    );
  }
}

// cm:why a build job is given the design revisions its requirement's baseline pins, or for an issue with no requirement the revision its approver approved, so it builds the journey it was held for rather than one it guesses at; an issue that reaches no design is given nothing
async function designsBuiltBy(issueId: string | null, subject: string): Promise<LoadedArtifact[]> {
  if (!issueId) return [];
  try {
    return await loadArtifactContext(issueId);
  } catch (err) {
    // cm:guard an unreadable approved revision stops the job as `ARTIFACT_CONTEXT_UNLOADABLE`: an agent given no design would build the journey blind
    const code = err instanceof ArtifactContextError ? err.code : 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw new JobContextRefused(
      code,
      `${code}: ${subject}: the approved design its issue builds could not be given (${errText(err)})`,
      { cause: err },
    );
  }
}

// cm:why a job on an issue that delivers a requirement is given its current revision's business criteria and the design revisions its baseline pins, so it builds what was agreed rather than what the description paraphrased
async function requirementServedBy(
  issueId: string | null,
  subject: string,
  mockupsWithheld: boolean,
): Promise<LoadedRequirement | null> {
  if (!issueId) return null;
  try {
    return await loadRequirementContext(issueId, mockupsWithheld);
  } catch (err) {
    // cm:guard a requirement that cannot be given at its current revision stops the job by name: a run given a superseded or unagreed revision would build the wrong intent
    const code = err instanceof RequirementContextError ? err.code : 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw new JobContextRefused(
      code,
      `${code}: ${subject}: the requirement its issue delivers could not be given (${errText(err)})`,
      { cause: err },
    );
  }
}

// cm:guard the artifact block reaches the job's agent through the one egress rule, the requirement
// as surface `requirement` and the designs as `design`; a refusal stops the job by name
async function givenToAgent(
  projectId: string,
  surface: EgressSurface,
  text: string | null,
  subject: string,
): Promise<string | null> {
  if (!text) return null;
  const out = egressText(await dataPolicyOf(projectId), surface, text, subject);
  if (!out.ok) {
    throw new JobContextRefused(
      out.refusal.code,
      `${out.refusal.code}: ${subject}: ${out.refusal.detail}`,
    );
  }
  return out.text;
}

function withContextBlock(
  prior: { systemPrompt: string; blocks: PreambleBlock[] },
  id: PreambleBlock['id'],
  body: string | null,
): { systemPrompt: string; blocks: PreambleBlock[] } {
  if (!body) return prior;
  return {
    systemPrompt: `${prior.systemPrompt}\n\n${body}`,
    blocks: [
      ...prior.blocks,
      { id, kind: 'system', chars: body.length, estTokens: estimateTokens(body) },
    ],
  };
}

/**
 * The system prompt a `step` job on `issueId` runs under. `subject` opens every refusal
 * (`prepare refused job <id>`, `preview refused issue <id>`).
 */
export async function buildJobSystemPrompt(input: {
  projectId: string;
  issueId: string | null;
  step: JobType;
  policy: DispatchState;
  subject: string;
}): Promise<JobSystemPrompt> {
  const { projectId, issueId, step, subject } = input;
  const deniedTools = await carvedDeniedTools(projectId, issueId, step, input.policy.deniedTools);
  const preamble = await buildPipelinePreambleStructured(projectId, {
    step,
    policy: { ...input.policy, deniedTools },
  });
  const [issueRow] = issueId
    ? await db
        .select({
          description: issues.description,
          plan: issues.plan,
          acceptanceCriteria: issues.acceptanceCriteria,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
    : [];
  const designs = await designsBuiltBy(issueId, subject);
  const withheld = withheldAt(await dataPolicyOf(projectId), 'mockup.content');
  const requirement = await requirementServedBy(issueId, subject, withheld);
  const issueMockups = issueId ? renderIssueMockups(await issueMockupsOf(issueId), withheld) : null;
  const contracts = await contractsNamedBy(projectId, issueRow, subject);
  const pinnedContracts = await contractsPinnedFor(requirement, subject);
  const artifactBlock =
    [
      await givenToAgent(projectId, 'requirement', requirement?.text ?? null, subject),
      await givenToAgent(projectId, 'design', renderArtifactContext(designs) || null, subject),
      await givenToAgent(projectId, 'issue', issueMockups, subject),
    ]
      .filter(Boolean)
      .join('\n\n') || null;
  const { systemPrompt, blocks } = withContextBlock(
    withContextBlock(
      withContextBlock(
        { systemPrompt: preamble.content, blocks: preamble.blocks },
        'artifact-context',
        artifactBlock,
      ),
      'contract-context',
      renderContractContext(contracts),
    ),
    'pinned-contract-context',
    await givenToAgent(
      projectId,
      'requirement',
      requirement ? renderPinnedContracts(requirement.key, pinnedContracts) : null,
      subject,
    ),
  );
  return {
    systemPrompt,
    blocks,
    contentLanguage: preamble.contentLanguage,
    deniedTools,
    designs,
    requirement,
    contracts,
    pinnedContracts,
  };
}
