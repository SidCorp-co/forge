import { scrubLogText } from "./index.js";

/** What a redaction replaced, by kind; `secret` counts lines the secret scrubber changed. */
export type PersonalDataKind = "email" | "number" | "name" | "secret";

export interface PersonalDataScrub {
	text: string;
	redactions: Record<PersonalDataKind, number>;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// cm:why a run of 9 to 19 digits, spaced or dashed, is a phone, national id or card number; a date
// or a time holds at most 8 digits, so it is left alone
const DIGIT_RUN = /\+?\d[\d .-]{6,}\d/g;
const MIN_DIGITS = 9;
const MAX_DIGITS = 19;

const NAME_LABELS = [
	"name",
	"full name",
	"patient",
	"patient name",
	"bệnh nhân",
	"tên",
	"họ tên",
	"họ và tên",
	"người bệnh",
	"bn",
];

// cm:why a labelled field ("Họ tên: …", "patient: …") names a person up to the end of its clause
const LABELLED = new RegExp(
	`(^|[\\s(\\[,;])((?:${NAME_LABELS.join("|")})\\s*[:=]\\s*)([^\\n,;)\\]]+)`,
	"giu",
);

// cm:why "bệnh nhân Nguyễn Văn An" / "patient John Smith": two to four capitalised words after
// the noun that marks a patient
const MARKED = new RegExp(
	"(^|[\\s(\\[,;])((?:[bB]ệnh nhân|[nN]gười bệnh|[pP]atient|BN)\\s+)((?:\\p{Lu}[\\p{Ll}\\p{M}]*\\s?){2,4})",
	"gu",
);

export const PERSONAL_DATA_PLACEHOLDER = {
	email: "[email]",
	number: "[number]",
	name: "[name]",
} as const;

/**
 * Redacts personal data a sensitive project must not store or send to a provider: email
 * addresses, phone / id / card numbers, labelled or patient-marked names, and every secret shape
 * `scrubLogText` knows. A name with no label or marker is not recognised; the count says what was.
 */
export function scrubPersonalData(input: string): PersonalDataScrub {
	const redactions: Record<PersonalDataKind, number> = {
		email: 0,
		number: 0,
		name: 0,
		secret: 0,
	};
	const secretsOut = scrubLogText(input);
	if (secretsOut !== input) {
		const before = input.split("\n");
		redactions.secret = secretsOut
			.split("\n")
			.filter((line, i) => line !== before[i]).length;
	}
	let text = secretsOut.replace(EMAIL, () => {
		redactions.email += 1;
		return PERSONAL_DATA_PLACEHOLDER.email;
	});
	text = text.replace(LABELLED, (_m, lead: string, label: string) => {
		redactions.name += 1;
		return `${lead}${label}${PERSONAL_DATA_PLACEHOLDER.name}`;
	});
	text = text.replace(MARKED, (_m, lead: string, marker: string, words: string) => {
		redactions.name += 1;
		return `${lead}${marker}${PERSONAL_DATA_PLACEHOLDER.name}${words.endsWith(" ") ? " " : ""}`;
	});
	text = text.replace(DIGIT_RUN, (run) => {
		const digits = run.replace(/\D/g, "").length;
		if (digits < MIN_DIGITS || digits > MAX_DIGITS) return run;
		redactions.number += 1;
		return PERSONAL_DATA_PLACEHOLDER.number;
	});
	return { text, redactions };
}

/** How many things a scrub replaced. */
export const redactionCount = (r: Record<PersonalDataKind, number>) =>
	r.email + r.number + r.name + r.secret;
