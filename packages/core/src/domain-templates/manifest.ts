import { z } from 'zod';
import { issueStatuses } from '../db/schema.js';

// Manifest shape stored in `domain_templates.manifest`. Keep this stable —
// `contentHash` is sha256 over the canonical JSON, so any field change bumps
// the hash and re-seeds builtins on next boot. See ../skills/builtin-seed.ts
// for the same content-addressed pattern used for skills.
export const domainTemplateManifestSchema = z
  .object({
    agentConfig: z
      .object({
        name: z.string().min(1).max(500),
        type: z.string().min(1).max(200),
        description: z.string().max(20_000).optional(),
        customInstructions: z.string().max(20_000).optional(),
        focusAreas: z.array(z.string().min(1).max(200)).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    appConfigDefaults: z
      .object({
        chatProviderId: z.string().min(1).max(200).optional(),
        chatModel: z.string().min(1).max(200).optional(),
        retrievalTopK: z.number().int().min(1).max(100).optional(),
        retrievalMinScore: z.number().min(0).max(1).optional(),
        enabledChannels: z.array(z.string().min(1).max(100)).optional(),
        systemPromptOverride: z.string().max(40_000).optional(),
      })
      .strict()
      .optional(),
    // Maps a builtin skill `name` (from skills/<dir>/SKILL.md frontmatter) to
    // the pipeline `stage` it should be registered at. Skills not yet seeded
    // are skipped on apply (logged) — they are not a hard failure because the
    // skill registry boots in parallel and the template can outlive the skill.
    skillRegistrations: z
      .array(
        z
          .object({
            skillName: z.string().min(1).max(200),
            stage: z.enum(issueStatuses),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

export type DomainTemplateManifest = z.infer<typeof domainTemplateManifestSchema>;

export interface BuiltinTemplate {
  key: string;
  name: string;
  description: string;
  manifest: DomainTemplateManifest;
}
