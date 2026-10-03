// cm:why one declaration of a project's content language (owner, 2026-10-04): the language agents
// write prose in for a project, never the language of code and never Forge's UI chrome. The project
// document, core's prompt block, REST, MCP and the web settings field all read it from here.

import { z } from "zod";

export const CONTENT_LANGUAGE_DEFAULT = "en";

export const CONTENT_LANGUAGE_CHOICES = [
	{ tag: "en", label: "English" },
	{ tag: "vi", label: "Tiếng Việt" },
] as const;

/** artifact: prose stored in Forge. chat: a reply, plus what the turn stores. code: code and its posts. */
export const CONTENT_LANGUAGE_CONTEXTS = ["artifact", "chat", "code"] as const;
export type ContentLanguageContext = (typeof CONTENT_LANGUAGE_CONTEXTS)[number];

export const CONTENT_LANGUAGE_REFUSAL_CODES = [
	"CONTENT_LANGUAGE_INVALID",
] as const;
export type ContentLanguageRefusalCode =
	(typeof CONTENT_LANGUAGE_REFUSAL_CODES)[number];

export const CONTENT_LANGUAGE_LIMITS = {
	tagMax: 35,
	keepTermsMax: 50,
	termMax: 60,
} as const;

/** Terms that stay English inside localized prose whatever the project adds. */
export const TECHNICAL_TERMS_KEPT_IN_ENGLISH = [
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

/** `keepTermsInEnglish` as the project document and the write body hold it. */
export const keepTermsInEnglishSchema = z
	.array(termSchema)
	.max(CONTENT_LANGUAGE_LIMITS.keepTermsMax);

/** `PUT /api/projects/:id/content-language`; `null` for the terms clears them. */
export const contentLanguageWriteSchema = z.strictObject({
	baseRevision: z.number().int().min(1),
	contentLanguage: z.string().min(1).max(CONTENT_LANGUAGE_LIMITS.tagMax),
	keepTermsInEnglish: keepTermsInEnglishSchema.nullable().optional(),
});
export type ContentLanguageWrite = z.infer<typeof contentLanguageWriteSchema>;
export const CONTENT_LANGUAGE_WRITE_SHAPE = `{ baseRevision: the project document revision read, contentLanguage: BCP-47 tag, keepTermsInEnglish?: string[] (≤${CONTENT_LANGUAGE_LIMITS.keepTermsMax}) | null }`;

/** What a project writes in, resolved: `source` says whether its document declared it. */
export interface ContentLanguageSetting {
	contentLanguage: string;
	keepTermsInEnglish: string[];
	source: "document" | "default";
}

/** `GET /api/projects/:id/content-language`, and the PUT's answer. */
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
