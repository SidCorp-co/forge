// An organisation's own knowledge (ISS-861): a ruling written once for every project of the org.
// Each always-on entry reaches every project's prompt ahead of the project's own, and a project entry
// under the same slug takes its place. Served at `/api/orgs/:orgId/knowledge/:slug`, org admin.

import { z } from "zod";
import {
	KNOWLEDGE_PROVENANCE_SHAPE,
	KNOWLEDGE_RECHECK_WHEN_MAX,
	KNOWLEDGE_SCOPE_MAX,
	KNOWLEDGE_SOURCE_MAX,
	type KnowledgeProvenance,
} from "./knowledge.js";

export const ORG_KNOWLEDGE_INJECTIONS = ["always", "on_demand"] as const;
export type OrgKnowledgeInjection = (typeof ORG_KNOWLEDGE_INJECTIONS)[number];

export const ORG_KNOWLEDGE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const ORG_KNOWLEDGE_SLUG_MAX = 200;
export const ORG_KNOWLEDGE_BODY_MAX = 100_000;

export const orgKnowledgeWriteSchema = z.strictObject({
	title: z.string().trim().min(1).max(300),
	body: z
		.string()
		.max(ORG_KNOWLEDGE_BODY_MAX)
		.refine((s) => s.trim().length > 0, "body must contain more than whitespace"),
	injection: z.enum(ORG_KNOWLEDGE_INJECTIONS).default("always"),
	orderIndex: z.number().int().min(0).max(10_000).default(0),
	// Optional here so that one left out is refused by name, `KNOWLEDGE_PROVENANCE_MISSING`, with the
	// shape, rather than as a generic body fault (ISS-1064): every org entry is a ruling or a guide.
	source: z.string().max(KNOWLEDGE_SOURCE_MAX).nullish(),
	scope: z.string().max(KNOWLEDGE_SCOPE_MAX).nullish(),
	recheckWhen: z.string().max(KNOWLEDGE_RECHECK_WHEN_MAX).nullish(),
});
export type OrgKnowledgeWrite = z.infer<typeof orgKnowledgeWriteSchema>;
export const ORG_KNOWLEDGE_WRITE_SHAPE = `{ title: string (1-300), body: string (1-${ORG_KNOWLEDGE_BODY_MAX}), injection?: ${ORG_KNOWLEDGE_INJECTIONS.join(" | ")} (default always), orderIndex?: integer 0-10000, source, scope, recheckWhen } where ${KNOWLEDGE_PROVENANCE_SHAPE}`;

export interface OrgKnowledgeEntry extends KnowledgeProvenance {
	orgId: string;
	slug: string;
	title: string;
	body: string;
	injection: OrgKnowledgeInjection;
	orderIndex: number;
	updatedBy: string | null;
	createdAt: string;
	updatedAt: string;
}
