// one declaration of a project's content language (owner, 2026-10-04): the language agents
// write prose in for a project, never the language of code and never Forge's UI chrome. The project
// document, core's prompt block, REST, MCP and the web settings field all read it from here.

import { z } from "zod";

const CONTENT_LANGUAGE_DEFAULT = "en";

export const CONTENT_LANGUAGE_CHOICES = [
	{ tag: "en", label: "English" },
	{ tag: "vi", label: "Tiếng Việt" },
] as const;

/** artifact: prose stored in Forge. chat: a reply, plus what the turn stores. code: code and its posts. */
const CONTENT_LANGUAGE_CONTEXTS = ["artifact", "chat", "code"] as const;
export type ContentLanguageContext = (typeof CONTENT_LANGUAGE_CONTEXTS)[number];

export const CONTENT_LANGUAGE_REFUSAL_CODES = [
	"CONTENT_LANGUAGE_INVALID",
] as const;

export const CONTENT_LANGUAGE_LIMITS = {
	tagMax: 35,
	keepTermsMax: 50,
	termMax: 60,
} as const;

/** Terms that stay English inside localized prose whatever the project adds. */
const TECHNICAL_TERMS_KEPT_IN_ENGLISH = [
	"API",
	"webhook",
	"SLA",
	"deploy",
	"release",
	"commit",
	"branch",
	"pull request",
	"merge",
	"endpoint",
	"token",
	"pipeline",
	"CI",
	"staging",
	"production",
	"runner",
	"schema",
	"migration",
	"cache",
	"frontend",
	"backend",
	"URL",
	"JSON",
] as const;

// language, then optional script, region and variants; extensions and private use name no language
const BCP47 =
	/^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-(?:[A-Za-z]{2}|[0-9]{3}))?(-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*$/;

/** Why `tag` cannot be a content language, or null. Only the canonical spelling is stored
 *  (`pt-BR`, not `pt-br`): a non-canonical one is refused naming it, never rewritten in silence. */
export function contentLanguageProblem(tag: string): string | null {
	const valid =
		'a BCP-47 language tag: a language subtag with an optional script and region, such as "vi", "en", "pt-BR" or "zh-Hant-TW"';
	if (tag.length > CONTENT_LANGUAGE_LIMITS.tagMax || !BCP47.test(tag)) {
		return `${JSON.stringify(tag)} is not ${valid}`;
	}
	let canonical: string | undefined;
	try {
		canonical = Intl.getCanonicalLocales(tag)[0];
	} catch {
		return `${JSON.stringify(tag)} is not ${valid}`;
	}
	if (canonical !== tag) {
		return `${JSON.stringify(tag)} is spelled ${JSON.stringify(canonical)} in canonical form; send that`;
	}
	return null;
}

/** The English name of a tag (`vi` → "Vietnamese"), or the tag itself where none is known. */
export function contentLanguageName(tag: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
	} catch {
		return tag;
	}
}

const termSchema = z
	.string()
	.trim()
	.min(1)
	.max(CONTENT_LANGUAGE_LIMITS.termMax);

/** `keepTermsInEnglish` as the project document holds it. */
export const keepTermsInEnglishSchema = z
	.array(termSchema)
	.max(CONTENT_LANGUAGE_LIMITS.keepTermsMax);

/** What a project writes in, resolved: `source` says whether its document declared it. */
interface ContentLanguageSetting {
	contentLanguage: string;
	keepTermsInEnglish: string[];
	source: "document" | "default";
}

/** `GET /api/projects/:id/content-language`. */
export interface ContentLanguageView extends ContentLanguageSetting {
	/** The project document revision this was read at; null when the project has none. */
	revision: number | null;
}

/** What a job or assistant session records as the language it was told. */
export interface ContentLanguageRecord extends ContentLanguageSetting {
	context: ContentLanguageContext;
	revision: number | null;
}

/** The setting a project document holds, defaults applied. */
export function contentLanguageOf(
	document: {
		contentLanguage?: string | undefined;
		keepTermsInEnglish?: string[] | undefined;
	} | null,
): ContentLanguageSetting {
	const declared = document?.contentLanguage;
	return {
		contentLanguage: declared ?? CONTENT_LANGUAGE_DEFAULT,
		keepTermsInEnglish: [...(document?.keepTermsInEnglish ?? [])],
		source: declared === undefined ? "default" : "document",
	};
}

/** The setting a project document holds at the revision read; a project with no document writes `en`. */
export function contentLanguageViewOf(
	held: {
		document: Parameters<typeof contentLanguageOf>[0];
		revision: number;
	} | null,
): ContentLanguageView {
	return {
		...contentLanguageOf(held?.document ?? null),
		revision: held?.revision ?? null,
	};
}

// The one place a prompt is told what language to write in: the job preamble, the in-core and BA
// assistant, and a chat session's cold start.

/** The metadata key a job or assistant session records the language it was told under. */
export const CONTENT_LANGUAGE_KEY = "contentLanguage";

// a job that never opens the repository writes only prose stored in Forge; every other job
// may commit, so it is told both halves: code English, Forge prose in the content language.
const ARTIFACT_JOB_TYPES: ReadonlySet<string> = new Set([
	"triage",
	"clarify",
	"plan",
]);

export function jobContentContext(type: string): ContentLanguageContext {
	return ARTIFACT_JOB_TYPES.has(type) ? "artifact" : "code";
}

const PERSISTED =
	"requirement text and criteria; workflow design labels, summaries and descriptions; comments and notes; questionnaires and onboarding messages; feedback triage text; suggestions; plan and summary prose; release notes";

function lead(language: string, context: ContentLanguageContext): string[] {
	if (context === "chat") {
		return [
			`- Answer the person in the language they wrote in. When you cannot tell which, answer in ${language}.`,
			`- Anything you store in Forge for this project is in ${language}, whoever asked and whatever language the conversation is in: ${PERSISTED}.`,
		];
	}
	if (context === "code") {
		return [
			"- Code, identifiers and file names are English, and so are commit messages, branch names, and pull request titles and descriptions: that is the code standard, not a translation choice.",
			`- Prose you post to Forge for this project is in ${language}: ${PERSISTED}.`,
		];
	}
	return [
		`- Write the prose you store in or show through Forge for this project in ${language}: ${PERSISTED}.`,
	];
}

/** The block for `setting` in `context`, ready to append to a system prompt. */
export function contentLanguageBlock(
	setting: ContentLanguageSetting,
	context: ContentLanguageContext,
): string {
	const tag = setting.contentLanguage;
	const language = `${contentLanguageName(tag)} (\`${tag}\`)`;
	const terms = [
		...TECHNICAL_TERMS_KEPT_IN_ENGLISH,
		...setting.keepTermsInEnglish,
	];
	return [
		"## Content language",
		`This project's content language is ${language}.`,
		...lead(language, context),
		`- Inside that prose, technical terms stay in English: ${terms.join(", ")}.`,
		"- Never translate machine-read text: ids, enum values, refusal codes, status names, step types, field names, `file:symbol` citations, code, identifiers, file names, commit messages, branch names, pull request titles. Forge UI labels are English.",
	].join("\n");
}

/** What a session records beside `artifactContext`: the setting it was told, in which context. */
export function contentLanguageRecord(
	setting: ContentLanguageSetting,
	context: ContentLanguageContext,
	revision: number | null,
): ContentLanguageRecord {
	return {
		...setting,
		keepTermsInEnglish: [...setting.keepTermsInEnglish],
		context,
		revision,
	};
}

/** Words a release note needs before its script is judged: a one-word or two-word line says too little to tell. */
export const SCRIPT_CHECK_MIN_WORDS = 6;

// the letters Vietnamese spells with and English never does: đ, the vowel marks, and the five tone marks
const VIETNAMESE_LETTER =
	/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

/**
 * The one test of whether prose plainly disagrees with a project's content language, or null.
 * It runs for `vi` only: a note of at least `SCRIPT_CHECK_MIN_WORDS` words with no Vietnamese
 * letter in it is not Vietnamese. No other language is guessed, and a note that passes is not
 * thereby judged to be in the language. `what` names the prose, so the sentence says which text it read.
 */
export function contentLanguageScriptWarning(
	tag: string,
	text: string,
	what: string,
): string | null {
	if (tag !== "vi") return null;
	const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
	if (words.length < SCRIPT_CHECK_MIN_WORDS) return null;
	if (VIETNAMESE_LETTER.test(text)) return null;
	return `${what} is ${words.length} words with no Vietnamese letter (no đ, no vowel or tone mark) in it, but this project's content language is ${contentLanguageName(tag)} (\`${tag}\`); it was stored as sent. Rewrite it in ${contentLanguageName(tag)}.`;
}

// A release note is read by the people who use the product, so it carries none of the engineer's
// handles for the change. These are the handles a reader cannot follow; a hit is a warning on the
// write and a line on the draft, never a refusal (policy input).
const NOTE_KEY = /\b(?:ISS|REQ|FB)-\d+\b/g;
// a commit sha: 7 to 40 hex digits holding a digit and a letter, so "defaced" and "2026100" are not read as one
const NOTE_SHA = /\b[0-9a-f]{7,40}\b/gi;
// a rule or error code of two parts or more: SOD-RULE-MAKER-CHECKER, RELEASE_RECORD_MISSING
const NOTE_CODE = /\b[A-Z][A-Z0-9]+(?:[_-][A-Z][A-Z0-9]+)+\b/g;
const NOTE_TECHNICAL_LABEL = /\btechnical note\b/i;

/** The engineer's references inside `text`, each named as it reads, in order of first appearance and once. */
export function releaseNoteReferences(text: string): string[] {
	const keys: string[] = text.match(NOTE_KEY) ?? [];
	const shas = (text.match(NOTE_SHA) ?? []).filter(
		(s) => /\d/.test(s) && /[a-f]/i.test(s),
	);
	const codes = (text.match(NOTE_CODE) ?? []).filter((c) => !keys.includes(c));
	const label = NOTE_TECHNICAL_LABEL.exec(text);
	return [
		...new Set([
			...shas.map((s) => `commit sha ${s}`),
			...keys.map((k) => `issue key ${k}`),
			...codes.map((c) => `code ${c}`),
			...(label ? [`label "${label[0]}"`] : []),
		]),
	];
}

/** What a release note's user-facing line needs attention for, in a project writing in `tag`. */
export interface ReleaseNoteAttention {
	notInLanguage: boolean;
	references: string[];
}

export function releaseNoteAttention(
	tag: string,
	userFacing: string,
): ReleaseNoteAttention {
	return {
		notInLanguage:
			contentLanguageScriptWarning(tag, userFacing, "releaseNotes.userFacing") !==
			null,
		references: releaseNoteReferences(userFacing),
	};
}

/** The one warning line for the references a note carries, or null; the note was stored as sent. */
export function releaseNoteReferenceWarning(
	text: string,
	what: string,
): string | null {
	const found = releaseNoteReferences(text);
	if (found.length === 0) return null;
	return `${what} carries ${found.join(", ")}: people who use the product cannot follow these; it was stored as sent. Rewrite it as the one plain line a user would read, and keep the engineering detail in \`technical\`.`;
}
