// The project document's acting secrets (REQ-88 BC-1): each a `secret://<scope>/<name>` the project
// stores, and the readers that may read it at the acting door (`acting-secret-door.ts`): the
// project's master, declared runs working its issues, or both. Named as ISS-707's `ops.secrets`
// names a secret, and kept apart from testing profiles, whose secrets judge landed work.

import { ACTING_SECRET_READERS } from '@forge/contracts/acting-secrets';
import { parseSecretRef } from '@forge/contracts/project-config';
import { SUPPORT_OWNER_CREDENTIAL_SCOPE } from '@forge/contracts/support';
import { z } from 'zod';
import { VARIABLE_SECRET_SCOPE } from '../db/schema-project-variables.js';

/** Scopes another door hands out: a variable at the run door, the owner's credential at support's. */
const RESERVED_SCOPES: Readonly<Record<string, string>> = {
  [VARIABLE_SECRET_SCOPE]:
    "holds the project's variable values, which a run reads at its variables door",
  [SUPPORT_OWNER_CREDENTIAL_SCOPE]:
    "holds the owner's credential a support room acts with, read only by that room",
};

const secretRef = z.string().superRefine((ref, ctx) => {
  const parsed = parseSecretRef(ref);
  if (!parsed) {
    ctx.addIssue({
      code: 'custom',
      message: 'a secret is named secret://<scope>/<name>, each part ^[a-z][a-z0-9-]{0,62}$',
    });
    return;
  }
  const reserved = RESERVED_SCOPES[parsed.scope];
  if (reserved) {
    ctx.addIssue({
      code: 'custom',
      message: `scope \`${parsed.scope}\` ${reserved}, and is declared for acting nowhere`,
    });
  }
});

const actingSecretSchema = z.strictObject({
  secret: secretRef,
  readers: z
    .array(z.enum(ACTING_SECRET_READERS))
    .min(1)
    .refine((r) => new Set(r).size === r.length, 'each reader is named once'),
});

export const actingSecretsSchema = z
  .array(actingSecretSchema)
  .min(1)
  .max(50)
  .refine(
    (all) => new Set(all.map((a) => a.secret)).size === all.length,
    'each secret is declared once',
  );

export type ActingSecretDeclaration = z.infer<typeof actingSecretSchema>;
