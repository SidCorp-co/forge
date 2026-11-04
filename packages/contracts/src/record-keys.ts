// A record's key (`ISS-673`, `REQ-66`, `FB-147`, `MK-10`, a project's own issue prefix) is how an agent
// names a record, never how a person reads it (the owner's UI rule: no raw ids or keys as visible
// text). Text a person reads that an agent wrote — a question's words, a title — often carries them:
// "ISS-582 (from hop FB-147): how should a product tour be drawn…". `withoutRecordKeys` reads that
// text as a person should, so a screen that draws it shows no key; the key itself stays in the link
// target, the aria label or the tooltip.

/** The prefixes every project's records answer to besides its own issue prefix. */
export const RECORD_KEY_PREFIXES = ["ISS", "REQ", "FB", "MK"] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` without the record keys it names: a bracketed aside that names one goes whole ("(from hop
 * FB-147)"), a key that leads goes with the colon or dash after it, and any other key goes where it
 * stands, the spaces and punctuation it leaves closed up. A sentence that led with a key starts with a
 * capital. `issuePrefixes` are the projects' own issue prefixes (`AF`, `FP2`), read beside the shared ones.
 * Text that is nothing but keys reads as empty.
 */
export function withoutRecordKeys(text: string, issuePrefixes: readonly string[] = []): string {
	const prefixes = [...new Set([...RECORD_KEY_PREFIXES, ...issuePrefixes.map((p) => p.toUpperCase())])]
		.filter((p) => /^[A-Z][A-Z0-9]{0,9}$/.test(p))
		.map(escape);
	const key = String.raw`\b(?:${prefixes.join("|")})-\d{1,10}\b`;
	const keyAnywhere = new RegExp(key);
	if (!keyAnywhere.test(text)) return text;
	const ledByKey = new RegExp(String.raw`^\s*${key}`).test(text);
	const out = text
		// an aside in brackets that names a key: "(from hop FB-147)", "[ISS-4]"
		.replace(new RegExp(String.raw`\s*\((?:[^()]*?)${key}(?:[^()]*?)\)|\s*\[(?:[^[\]]*?)${key}(?:[^[\]]*?)\]`, "g"), "")
		// a run of keys with what joins them, and a colon or dash that follows: "ISS-1, ISS-2:"
		.replace(new RegExp(String.raw`${key}(?:\s*(?:,|/|&|and)\s*${key})*(?:\s*[:—–]|\s+-(?=\s))?`, "g"), "")
		.replace(/\s+([?.!,;:)\]])/g, "$1")
		.replace(/([([])\s+/g, "$1")
		.replace(/\s{2,}/g, " ")
		.replace(/^[\s:;,.·—–-]+/, "")
		.trim();
	return ledByKey && out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}
