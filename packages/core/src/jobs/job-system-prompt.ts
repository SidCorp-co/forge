/**
 * The system prompt a job on an issue runs under: the pipeline preamble, then the artifact,
 * contract and pinned-contract blocks its issue reaches. Nothing here writes; recording the loads
 * on a session is `prepare-claimed-job.ts`'s.
 */

import type { ContentLanguageRecord } from '@forge/contracts/content-language';
import type { PreambleBlock } from '@forge/contracts/jobs';
import type { DispatchState } from '@forge/contracts/project-config';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type JobType } from '../db/schema.js';
import { dataPolicyOf, type EgressSurface, egressText, withheldAt } from '../lib/data-egress.js';
import { isRefusal, RefusalError, refusalCodeOf } from '../lib/refusal.js';
import { estimateTokens } from '../lib/token-estimator.js';
import { type GivenRequirement, jobsPorts } from './ports.js';

/** A context the job's issue reaches that cannot be given; the job is refused, never built blind. */
const contextRefused = (code: string, detail: string) =>
  new RefusalError([{ code, path: '', detail }], 'JOB_CONTEXT_REFUSED');

interface JobSystemPrompt {
  systemPrompt: string;
  blocks: PreambleBlock[];
  contentLanguage: ContentLanguageRecord | undefined;
  deniedTools: string[];
  designs: readonly unknown[];
  requirement: GivenRequirement | null;
  contracts: readonly unknown[];
  pinnedContracts: readonly unknown[];
}

type IssueText = {
  description: string | null;
  plan: string | null;
  acceptanceCriteria: string | null;
};

const errText = (err: unknown) =>
  isRefusal(err)
    ? err.refusals.map((r) => r.detail).join('; ')
    : err instanceof Error
      ? err.message
      : String(err);

// a run is given the contracts its issue's named paths reach before it starts, since the paths it will change are not known yet; it asks forge_ecosystem action=context (MCP-only) for paths it finds later
async function contractsNamedBy(
  projectId: string,
  issue: IssueText | undefined,
  subject: string,
): Promise<readonly unknown[]> {
  if (!issue) return [];
  const text = [issue.description, issue.plan, issue.acceptanceCriteria].filter(Boolean).join('\n');
  try {
    const context = jobsPorts().jobContext;
    return await context.loadContractContext(projectId, context.pathsNamedIn(text));
  } catch (err) {
    // a run whose contract context cannot be read is refused, never prepared without it — it would edit a call site blind (owner, 2026-10-02)
    throw contextRefused(
      'CONTRACT_CONTEXT_UNLOADABLE',
      `${subject}: the contracts its issue's paths reach could not be read (${errText(err)})`,
    );
  }
}

// A job on an issue that delivers a requirement is given every contract version the requirement's
// latest baseline pins, the provider's and the consumer's issue alike (requirement-to-delivery,
// edge delivery -> build); a pinned version that cannot be given refuses the job by name.
async function contractsPinnedFor(
  requirement: GivenRequirement | null,
  subject: string,
): Promise<readonly unknown[]> {
  if (!requirement) return [];
  try {
    return await jobsPorts().jobContext.loadPinnedContracts(requirement.key, requirement.pins);
  } catch (err) {
    const code = refusalCodeOf(err) ?? 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw contextRefused(
      code,
      `${subject}: the contract versions its requirement pins could not be given (${errText(err)})`,
    );
  }
}

// a build job is given the design revisions its requirement's baseline pins, or for an issue with no requirement the revision its approver approved, so it builds the journey it was held for rather than one it guesses at; an issue that reaches no design is given nothing
async function designsBuiltBy(
  issueId: string | null,
  subject: string,
): Promise<readonly unknown[]> {
  if (!issueId) return [];
  try {
    return await jobsPorts().jobContext.loadArtifactContext(issueId);
  } catch (err) {
    // an unreadable approved revision stops the job as `ARTIFACT_CONTEXT_UNLOADABLE`: an agent given no design would build the journey blind
    const code = refusalCodeOf(err) ?? 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw contextRefused(
      code,
      `${subject}: the approved design its issue builds could not be given (${errText(err)})`,
    );
  }
}

// a job on an issue that delivers a requirement is given its current revision's business criteria and the design revisions its baseline pins, so it builds what was agreed rather than what the description paraphrased
async function requirementServedBy(
  issueId: string | null,
  subject: string,
  mockupsWithheld: boolean,
): Promise<GivenRequirement | null> {
  if (!issueId) return null;
  try {
    return await jobsPorts().jobContext.loadRequirementContext(issueId, mockupsWithheld);
  } catch (err) {
    // a requirement that cannot be given at its current revision stops the job by name: a run given a superseded or unagreed revision would build the wrong intent
    const code = refusalCodeOf(err) ?? 'ARTIFACT_CONTEXT_UNLOADABLE';
    throw contextRefused(
      code,
      `${subject}: the requirement its issue delivers could not be given (${errText(err)})`,
    );
  }
}

// the artifact block reaches the job's agent through the one egress rule, the requirement
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
    throw contextRefused(out.refusal.code, `${subject}: ${out.refusal.detail}`);
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
  const { deniedTools } = input.policy;
  const preamble = await jobsPorts().buildPipelinePreamble(projectId, {
    step,
    policy: input.policy,
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
  const context = jobsPorts().jobContext;
  const issueMockups = issueId
    ? context.renderIssueMockups(await context.issueMockupsOf(issueId), withheld)
    : null;
  const contracts = await contractsNamedBy(projectId, issueRow, subject);
  const pinnedContracts = await contractsPinnedFor(requirement, subject);
  const artifactBlock =
    [
      await givenToAgent(projectId, 'requirement', requirement?.text ?? null, subject),
      await givenToAgent(
        projectId,
        'design',
        context.renderArtifactContext(designs) || null,
        subject,
      ),
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
      context.renderContractContext(contracts),
    ),
    'pinned-contract-context',
    await givenToAgent(
      projectId,
      'requirement',
      requirement ? context.renderPinnedContracts(requirement.key, pinnedContracts) : null,
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
