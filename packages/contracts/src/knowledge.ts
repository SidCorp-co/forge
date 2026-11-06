// The codes a knowledge entry write refuses under.

export const KNOWLEDGE_REFUSAL_CODES = [
	"KNOWLEDGE_REFUSED",
	"KNOWLEDGE_READ_WHEN_SHAPE",
	"KNOWLEDGE_LESSON_OWNED",
	"KNOWLEDGE_DECIDERS_SHAPE",
	"KNOWLEDGE_PROVENANCE_MISSING",
] as const;

export type KnowledgeRefusalCode = (typeof KNOWLEDGE_REFUSAL_CODES)[number];

// What a knowledge entry rests on, where it applies and when it stops being true (ISS-1064). An entry
// of one of these kinds, and every org entry, is written with all three or refused
// `KNOWLEDGE_PROVENANCE_MISSING` naming each one left out. A lesson keeps its own provenance in the
// lessons module; an overview, scenario or glossary describes rather than asserts, and owes none.
export const KNOWLEDGE_PROVENANCE_KINDS = ["reference", "guide", "workflow", "rule"] as const;
export type KnowledgeProvenanceKind = (typeof KNOWLEDGE_PROVENANCE_KINDS)[number];

export const KNOWLEDGE_PROVENANCE_FIELDS = ["source", "scope", "recheckWhen"] as const;
export type KnowledgeProvenanceField = (typeof KNOWLEDGE_PROVENANCE_FIELDS)[number];

export const KNOWLEDGE_SOURCE_MAX = 2000;
export const KNOWLEDGE_SCOPE_MAX = 500;
export const KNOWLEDGE_RECHECK_WHEN_MAX = 1000;

/** The longest each provenance field may be, by field. */
export const KNOWLEDGE_PROVENANCE_MAX: Record<KnowledgeProvenanceField, number> = {
	source: KNOWLEDGE_SOURCE_MAX,
	scope: KNOWLEDGE_SCOPE_MAX,
	recheckWhen: KNOWLEDGE_RECHECK_WHEN_MAX,
};

/** Each field's own shape: what it holds, its length and an example, as a refusal names it. */
export const KNOWLEDGE_PROVENANCE_FIELD_SHAPES: Record<KnowledgeProvenanceField, string> = {
	source:
		`source: string (1-${KNOWLEDGE_SOURCE_MAX}), what the entry rests on: \`file.ts:symbol\` anchors, ` +
		`an issue or requirement key, or a URL, e.g. "packages/core/src/knowledge/upsert.ts:upsertKnowledgeEntries, ISS-1064"`,
	scope: `scope: string (1-${KNOWLEDGE_SCOPE_MAX}), where it applies, e.g. "every knowledge write of this project"`,
	recheckWhen:
		`recheckWhen: string (1-${KNOWLEDGE_RECHECK_WHEN_MAX}), the change that means it needs re-checking, ` +
		`e.g. "upsertKnowledgeEntries moves or the knowledge kinds change"`,
};

/** The shape a refusal names: the three fields, what each holds and an example of each. */
export const KNOWLEDGE_PROVENANCE_SHAPE = `{ ${KNOWLEDGE_PROVENANCE_FIELDS.map((f) => KNOWLEDGE_PROVENANCE_FIELD_SHAPES[f]).join("; ")} }`;

/** The three fields as a read answers them: null on an entry written before they were asked for. */
export interface KnowledgeProvenance {
	source: string | null;
	scope: string | null;
	recheckWhen: string | null;
}

// What an always-inject knowledge entry may cost every prompt, and what flagging one does and does not buy.
export const ALWAYS_INJECT_MAX_CHARS = 6000;

export const ALWAYS_INJECT_GUARANTEE_NOTE =
	"Flagging a fact always-inject guarantees it is READ, never that it was DONE: the body " +
	"reaches every agent prompt, and nothing checks whether the agent followed it.";

export const ALWAYS_INJECT_ENFORCEMENT_NOTE =
	"No gate refuses a step that ignored an always-inject rule, no step is asked whether it " +
	"complied, and no surface counts how often one was obeyed; what was injected is visible " +
	"afterwards on the job, whether it was followed is recorded nowhere. No obligation on this " +
	"deployment has a readback today: the one that did was the UX contract, whose rules carried " +
	"ids for agents to cite back, and it was retired because in sixteen days of always " +
	"injecting it on twelve projects it was cited back zero times. So the price is known and " +
	"nobody is paying it: write the rule so that an agent following it leaves evidence a human " +
	"can look at, and expect no gate to ask for that evidence.";
