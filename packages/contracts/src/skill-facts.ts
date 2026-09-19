import { z } from 'zod';
import { REGISTRY_JOB_TYPES } from './pipeline-registry.js';

export const SKILL_FACT_CATEGORIES = ['enum', 'protocol', 'format', 'reference'] as const;
export const SKILL_FACT_TIERS = ['mandatory', 'contextual'] as const;
export const SKILL_FACT_SCOPES = ['global', 'project-resolved'] as const;
export const SKILL_FACT_NAMESPACES = ['forge', 'project'] as const;

export const skillFactSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(SKILL_FACT_CATEGORIES),
  /** `mandatory` = always auto-injected; `contextual` = inserted via variable. */
  tier: z.enum(SKILL_FACT_TIERS),
  scope: z.enum(SKILL_FACT_SCOPES),
  namespace: z.enum(SKILL_FACT_NAMESPACES),
  /** Stages this fact is most relevant to — drives Studio palette suggestions. */
  appliesTo: z.array(z.enum(REGISTRY_JOB_TYPES)).optional(),
  version: z.number().int().positive(),
  /** Project-resolved canonical text (what the agent would receive). */
  preview: z.string(),
});
export type SkillFact = z.infer<typeof skillFactSchema>;

export const skillFactsResponseSchema = z.object({
  facts: z.array(skillFactSchema),
});
export type SkillFactsResponse = z.infer<typeof skillFactsResponseSchema>;
