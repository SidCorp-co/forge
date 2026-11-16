// The families a Tier-0 map groups its cards by (ISS-1251 criterion 5: a cap triggers merging, never
// truncation). A family is acts an agent reaches for in one situation; the map gives it one line,
// "when <its situation> → its doors", and each card keeps its own situations, read in full when its
// act is used. The text here is that merged situation, short, so a whole audience's map fits its cap.

export const CARD_FAMILIES = {
	"room.message":
		"a message comes in: decide it, and read who wrote it, its thread and its pictures",
	"room.record":
		"a writer, a channel rule or a chat account is missing from the record",
	"room.answer":
		"you answer a message or stay silent, then audit what you posted",
	"room.facts":
		"you need a fact: how the product works, what runs where, how work stands, or your guide",
	"room.diagnose": "something is broken, or a scheduled check is handed to you",
	"room.consent":
		"work is for the team, or a change waits on a person's own yes",
	"room.live":
		"you would say done or live, or a person waits on or decides a release",
	"room.hand-on":
		"you cannot make an act, lack a grant, or a need belongs to someone else",
	"room.owner":
		"only the owner can answer or decide, or he answered or asked you to act",
	"room.references":
		"a source, link or document is to be read first, cited, followed or proposed",
	channel:
		"a channel document is owed, or someone asks what other projects sent, await or offer",
	"project-feedback":
		"a product finding is to be filed, or someone asks what became of a report",
	"forge-feedback": "Forge itself, or one of its doors or guides, failed you",
	memory: "you need what earlier work settled before you design or fix",
} as const;

export type CardFamily = keyof typeof CARD_FAMILIES;

export const CARD_FAMILY_IDS = Object.keys(CARD_FAMILIES) as [
	CardFamily,
	...CardFamily[],
];
