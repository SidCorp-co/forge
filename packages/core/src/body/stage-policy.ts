/**
 * A stage may REQUIRE a component, and a body that omits it is refused by name.
 *
 * `release-record-required.ts` states the shape this follows: a rule that
 * decides what a write owes AT A STAGE, refusing the write rather than
 * accepting it with a warning. That mechanism produced 100 % compliance for
 * `releaseNotes` where a guide produced 14-28 %, and building a second,
 * differently-shaped gate beside it would be two rules that disagree silently.
 *
 * What is generalised is the SHAPE, not the code path: that rule gates a status
 * transition on a field of the issue, this one gates a body write on the markup
 * it carries. Nothing is shared but the doctrine.
 *
 * Off everywhere until a project declares it. `defaultStatesConfig()` does not
 * name `bodyPolicy`, so no project acquires one by upgrading — the accidental
 * global default here would refuse writes on every tenant project at once.
 */

import type { ActorAgency } from '../issues/actor-agency.js';
import type { StageName } from '../pipeline/pipeline-config-schema.js';

export interface StageBodyPolicy {
  stage: StageName;
  requireComponent: string;
}

export class BodyComponentRequiredError extends Error {
  readonly code = 'BODY_COMPONENT_REQUIRED';

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BodyComponentRequiredError';
  }
}

interface StageBodyPolicyDoc {
  requireComponent?: unknown;
}

interface StagesDoc {
  [stage: string]: { bodyPolicy?: StageBodyPolicyDoc } | undefined;
}

/**
 * The stored `agentConfig` as this reader needs it. Typed structurally rather
 * than imported: `projects.agentConfig` is jsonb written by several eras of
 * this schema, and a row that predates a key must read as absent, not throw.
 */
export interface BodyPolicyConfigSource {
  pipelineConfig?: { states?: StagesDoc } | null;
}

/**
 * Which component this stage requires, or `null` for the overwhelming majority
 * of (project, stage) pairs that require nothing.
 *
 * `stage` is the issue's kernel status at the moment of the write — the same
 * thing `STAGE_NAMES` keys `states` by. A status outside that set has no stage
 * config at all and therefore no policy.
 */
// cm:edge contract -> packages/core/src/pipeline/pipeline-config-schema.ts — `stageConfigSchema.bodyPolicy` is the writer of the document this reads, and that schema STRIPS unknown keys: a field read here that is not declared there is dropped by the next settings save and silently never takes effect.
export function resolveStageBodyPolicy(
  agentConfig: BodyPolicyConfigSource | null | undefined,
  stage: string,
): StageBodyPolicy | null {
  const declared = agentConfig?.pipelineConfig?.states?.[stage]?.bodyPolicy?.requireComponent;
  if (typeof declared !== 'string' || declared.length === 0) return null;
  return { stage: stage as StageName, requireComponent: declared };
}

/**
 * The refusal, or `null` when the write may proceed.
 *
 * `agency` is the caller's, derived in the ONE place a principal is built
 * (`middleware/require-pat.ts`) from the token owner's `users.kind`, and passed
 * down rather than re-decided here.
 *
 * It is deliberately NOT `authorDeviceId !== null`, which is what this rule was
 * first written against. ISS-932 wave 4 made that column the BOX a credential
 * was issued to, and a driver's `job:` token carries no box — so a mandate keyed
 * on it fires for almost nobody while its adoption number reads a confident
 * zero, which is the shape of wrong that never gets noticed.
 */
// cm:edge contract -> packages/core/src/middleware/require-pat.ts — `agency` comes from the token OWNER (`users.kind === 'agent'`), for `/mcp` and REST alike; a door that hands this rule a value decided any other way makes the mandate and the ISS-786/812 evidence gates disagree about who an agent is.
// cm:guard a human is never refused by this rule, at any stage, and the exemption is `agency` alone — a mandate exists to make an automated writer emit a typed record, and a person writing prose into the comment box is not what any project turned it on for. Widening this to people makes the tracker's own comment field refuse a sentence, which is the one outcome that would make a project turn the whole mechanism back off.
export function refuseMissingComponent(input: {
  policy: StageBodyPolicy | null;
  agency: ActorAgency | null;
  format: string;
  template: string | null;
}): BodyComponentRequiredError | null {
  const { policy, agency, format, template } = input;
  if (!policy) return null;
  if (agency !== 'agent') return null;
  if (format === 'html' && template === policy.requireComponent) return null;

  const want = policy.requireComponent;
  return new BodyComponentRequiredError(
    `this project requires a \`<${want}>\` body on a comment written at stage \`${policy.stage}\`, ` +
      `and this one is ${describeWhatArrived(format, template)}. Write the comment as ` +
      `\`<${want}> … </${want}>\` — send it with \`format: 'html'\`, or just open the body with ` +
      `\`<${want}\`, which resolves to \`html\` on its own. Prose may go inside the component's ` +
      'slots; it may not replace it.',
    { requires: want, stage: policy.stage, code: 'BODY_COMPONENT_REQUIRED' },
  );
}

function describeWhatArrived(format: string, template: string | null): string {
  if (format !== 'html') return `\`${format}\``;
  return template ? `a \`<${template}>\` body` : 'html with no root component';
}
