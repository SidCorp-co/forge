import { z } from 'zod';
import { type BindingRole, bindingRoles, type DeployStage, deployStages } from '../db/schema.js';
import { deployCapableProviders, providerCanDeploy } from './registry.js';

export const roleSchema = z.enum(bindingRoles);
export const stagesSchema = z.array(z.enum(deployStages)).min(1).max(2);

export const bindingShapeFields = {
  role: roleSchema,
  stages: stagesSchema.optional(),
} as const;

/**
 * The three ways a `role`/`stages` pair can be wrong, each refused by name rather than normalised.
 *
 * Shared by the create body and the bind-existing body, because a caller who reaches the same wrong
 * shape through the second door deserves the same sentence.
 */
export function checkRoleStagesPairing(
  value: { role: BindingRole; stages?: DeployStage[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.role === 'service' && value.stages !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['stages'],
      message:
        'a `service` binding serves no stage, so it takes no `stages` — it is a project-wide facility (an error tracker, a chat room, a repo host). Send `role: "deploy"` with `stages` if this binding is somewhere Forge deploys to.',
    });
    return;
  }
  if (value.role !== 'deploy') return;
  if (value.stages && new Set(value.stages).size !== value.stages.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['stages'],
      message: `\`stages\` is a set, so each stage appears at most once — \`${JSON.stringify(value.stages)}\` names one twice. Send \`["preview"]\`, \`["live"]\`, or \`["preview","live"]\`.`,
    });
    return;
  }
  if (!value.stages || value.stages.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['stages'],
      message:
        'a `deploy` binding must declare at least one stage: `["preview"]`, `["live"]`, or `["preview","live"]` for one endpoint that serves both (an epodsystem store, whose preview is the draft theme and whose live is the published one).',
    });
  }
}

/** The sentence a caller gets for `role: 'deploy'` on a provider Forge cannot deploy to. */
export function cannotDeployMessage(provider: string): string {
  return `Forge cannot deploy to \`${provider}\` — it has no deploy adapter, so this binding can only be \`role: "service"\`. Deploy-capable providers: ${deployCapableProviders().join(', ')}.`;
}

/**
 * The pairing check plus the provider-capability one, for the door that carries a provider in its
 * body. The bind-existing door reads its provider off the connection, so it runs the two separately.
 */
export function checkBindingShape(
  value: { provider: string; role: BindingRole; stages?: DeployStage[] | undefined },
  ctx: z.RefinementCtx,
): void {
  checkRoleStagesPairing(value, ctx);
  if (value.role === 'deploy' && !providerCanDeploy(value.provider)) {
    ctx.addIssue({ code: 'custom', path: ['role'], message: cannotDeployMessage(value.provider) });
  }
}
