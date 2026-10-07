// The codes a knowledge entry write refuses under.

export const KNOWLEDGE_REFUSAL_CODES = ["KNOWLEDGE_REFUSED", "KNOWLEDGE_READ_WHEN_SHAPE"] as const;

export type KnowledgeRefusalCode = (typeof KNOWLEDGE_REFUSAL_CODES)[number];

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
