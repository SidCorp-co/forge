// Client-facing contract for `GET /api/skill-facts` and the MCP
// `forge_skill_facts` tool. A "fact" is a unit of FIXED Forge process
// knowledge (status ladder, complexity scale, decompose protocol, …) that a
// skill body references via `{{forge:<id>}}` / `{{project:<key>}}` instead of
// copy-pasting. The runtime registry + render logic live in
// `@forge/core/src/prompt/facts`; this file is the Zod contract.
//
// As with pipeline-registry.ts, enum tuples are hardcoded here (not imported
// from core, which has env side effects at load). A parity test in
// `packages/core/src/prompt/facts/registry.test.ts` keeps them in sync.

import { z } from 'zod';
import { REGISTRY_JOB_TYPES } from './pipeline-registry.js';

export const SKILL_FACT_CATEGORIES = ['enum', 'protocol', 'format', 'reference'] as const;
export const SKILL_FACT_TIERS = ['mandatory', 'contextual'] as const;
export const SKILL_FACT_SCOPES = ['global', 'project-resolved'] as const;
export const SKILL_FACT_NAMESPACES = ['forge', 'project'] as const;

export const skillFactSchema = z.object({
  /** Stable id used in `{{forge:<id>}}` / `{{project:<id>}}`. */
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
