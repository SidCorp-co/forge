import { z } from 'zod';
import { type BindingRole, bindingRoles } from '../db/schema.js';
import { deployCapableProviders, providerCanDeploy } from './registry.js';

export const roleSchema = z.enum(bindingRoles).exclude(['source']);

const STAGES_RETIRED =
  "a binding carries no `stages`: which environment a deploy binding serves is the project document's, `environments.<name>.deployment.binding` (`PUT /api/projects/:id/config`), and production is the environment whose `tier` is `production`. Send this body without `stages`.";

/** Refused by name on every door that once took it, rather than stripped. */
export const retiredStagesField = z.never({ error: STAGES_RETIRED }).optional();

export const bindingShapeFields = {
  role: roleSchema,
  stages: retiredStagesField,
} as const;

export function cannotDeployMessage(provider: string): string {
  return `Forge cannot deploy to \`${provider}\` — it has no deploy adapter, so this binding can only be \`role: "service"\`. Deploy-capable providers: ${deployCapableProviders().join(', ')}.`;
}

/** The provider-capability check, for the door that carries a provider in its body. The
 *  bind-existing door reads its provider off the connection, so it runs it separately. */
export function checkBindingShape(
  value: { provider: string; role: BindingRole },
  ctx: z.RefinementCtx,
): void {
  if (value.role === 'deploy' && !providerCanDeploy(value.provider)) {
    ctx.addIssue({ code: 'custom', path: ['role'], message: cannotDeployMessage(value.provider) });
  }
}
