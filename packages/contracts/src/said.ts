// What core says, as a message id and the values it carries (ISS C5-9): every standing sentence
// core builds (whom a row waits on, what they owe, why, a gate's reading, a blocker, an integration
// row's health) goes out as its English text AND as `{ key, vars }`, so a reader in another language
// renders the key in its own words instead of re-parsing core's English. The shape is FormatJS's
// message descriptor (`id` + `values`) and Fluent's `formatPattern(id, args)`: the id names the
// sentence, the vars are typed facts (a count, a version, an ISO date), and only the template is
// per language. The registry is `said-keys.ts`; its English is the one core's text is built from.

import { z } from "zod";
import type { IssueStatus } from "./issue-machine.js";
import { ISSUE_STATUS_LABELS } from "./issue-vocabulary.js";
import { SAID } from "./said-keys.js";

/**
 * What a var holds, so a reader formats it by kind rather than guessing from its name:
 * - `name`: a name core carries over untouched (a person, a design, a provider, a host, a runner)
 * - `text`: words a person, a run or an adapter wrote; carried over untouched, never translated
 * - `count`: a whole number
 * - `version`: a release version
 * - `key`: an entity's key, or several joined by ", " (`ISS-4, ISS-5`, `BC-1`)
 * - `permission`: a project permission id (`project.write`)
 * - `date`: an ISO calendar date (`2026-10-05`)
 * - `instant`: an ISO timestamp (`2026-10-05T08:00:00.000Z`)
 * - `status` / `statusLabel`: an issue status id; English writes the id, or its label
 * - `step`: a work step id; English writes its capitalised word
 * - `health`: an integration connection's health value
 * - `code`: a refusal or reason code (`TRANSITION_REFUSED`)
 * - `agreement`: an English agreement word (is/are, its/their) only the English template uses
 * - `said` / `said?`: another sentence of this registry; `said?` may be null and reads as nothing
 * - `saidList`: several sentences of this registry, joined by "; "
 * - `saidSeries`: several sentences of this registry, joined by ", "
 * - `saidDots`: several sentences of this registry, joined by " · "
 */
export const SAID_KINDS = [
	"name",
	"text",
	"count",
	"version",
	"key",
	"permission",
	"date",
	"instant",
	"status",
	"statusLabel",
	"step",
	"health",
	"code",
	"agreement",
	"said",
	"said?",
	"saidList",
	"saidSeries",
	"saidDots",
] as const;
export type SaidKind = (typeof SAID_KINDS)[number];

export interface SaidEntry {
	readonly en: string;
	readonly vars?: Readonly<Record<string, SaidKind>>;
}

export type SaidKey = keyof typeof SAID;

/** One sentence core says: its registry key and the values its template carries. */
export interface Said {
	key: SaidKey;
	vars?: Record<string, SaidValue>;
}
export type SaidValue = string | number | Said | null | readonly Said[];

type ValueOf<K> = K extends "count"
	? number
	: K extends "said"
		? Said
		: K extends "said?"
			? Said | null
			: K extends "saidList" | "saidSeries" | "saidDots"
				? readonly Said[]
				: string;

/** The vars `key`'s template declares, each typed by its kind. */
export type SaidVars<K extends SaidKey> = (typeof SAID)[K] extends {
	vars: infer V;
}
	? { -readonly [N in keyof V]: ValueOf<V[N]> }
	: never;

/** A key whose template carries no values: said by its key alone. */
export type SaidPlainKey = {
	[K in SaidKey]: [SaidVars<K>] extends [never] ? K : never;
}[SaidKey];

const ENTRIES: Readonly<Record<string, SaidEntry>> = SAID;

/** A key the registry lacks, or vars that do not fill its template: refused by name, never rendered as a guess. */
export class SaidRefused extends Error {
	constructor(
		readonly code: "SAID_KEY_UNKNOWN" | "SAID_VAR_MISSING" | "SAID_VAR_KIND",
		detail: string,
	) {
		super(`${code}: ${detail}`);
		this.name = "SaidRefused";
	}
}

function checked(
	key: string,
	vars: Record<string, SaidValue> | undefined,
): void {
	const entry = ENTRIES[key];
	if (!entry)
		throw new SaidRefused(
			"SAID_KEY_UNKNOWN",
			`"${key}" is not in @forge/contracts/said-keys`,
		);
	for (const [name, kind] of Object.entries(entry.vars ?? {})) {
		const v = vars?.[name];
		if (v === undefined)
			throw new SaidRefused(
				"SAID_VAR_MISSING",
				`"${key}" needs {${name}} (${kind})`,
			);
		const ok =
			kind === "count"
				? typeof v === "number"
				: kind === "said"
					? isSaid(v)
					: kind === "said?"
						? v === null || isSaid(v)
						: kind === "saidList" ||
								kind === "saidSeries" ||
								kind === "saidDots"
							? Array.isArray(v)
							: typeof v === "string";
		if (!ok)
			throw new SaidRefused(
				"SAID_VAR_KIND",
				`"${key}" {${name}} must be ${kind}, got ${JSON.stringify(v)}`,
			);
		if (isSaid(v)) checked(v.key, v.vars);
		if (Array.isArray(v))
			for (const x of v as readonly Said[]) checked(x.key, x.vars);
	}
}

const isSaid = (v: unknown): v is Said =>
	typeof v === "object" &&
	v !== null &&
	!Array.isArray(v) &&
	typeof (v as Said).key === "string";

/** One sentence by its key; a key the registry lacks or a var its template does not get is refused here, where it is built. */
export function say<K extends SaidKey>(
	key: K,
	...vars: [SaidVars<K>] extends [never] ? [] : [SaidVars<K>]
): Said {
	const v = vars[0] as Record<string, SaidValue> | undefined;
	checked(key, v);
	return v === undefined ? { key } : { key, vars: v };
}

/** How one language reads the registry: its template for a key, a var by its kind, and what a key it cannot read shows. */
export interface SaidReader {
	template(key: SaidKey): string | undefined;
	value(kind: SaidKind, value: string | number): string;
	unknown(key: string): string;
}

/** A sentence in the reader's words. A key the registry lacks reads as the reader's `unknown`. */
export function renderSaid(s: Said, reader: SaidReader): string {
	const entry = ENTRIES[s.key];
	const template = entry ? reader.template(s.key) : undefined;
	if (!entry || template === undefined) return reader.unknown(s.key);
	const kinds = entry.vars ?? {};
	return template.replace(/\{(\w+)\}/g, (slot, name: string) => {
		const kind = kinds[name];
		const v = s.vars?.[name];
		if (kind === undefined || v === undefined) return slot;
		if (v === null) return "";
		if (Array.isArray(v)) {
			return v
				.map((x: Said) => renderSaid(x, reader))
				.join(JOINERS[kind] ?? "; ");
		}
		if (typeof v === "object") return renderSaid(v as Said, reader);
		return reader.value(kind, v as string | number);
	});
}

const JOINERS: Partial<Record<SaidKind, string>> = {
	saidList: "; ",
	saidSeries: ", ",
	saidDots: " · ",
};

const STEP_WORD: Record<string, string> = {
	triage: "Triage",
	clarify: "Clarify",
	plan: "Plan",
	build: "Build",
	test: "Test",
	release: "Release",
};

const ENGLISH: SaidReader = {
	template: (key) => ENTRIES[key]?.en,
	value: (kind, v) =>
		kind === "step"
			? (STEP_WORD[String(v)] ??
				`${String(v).charAt(0).toUpperCase()}${String(v).slice(1)}`)
			: kind === "statusLabel"
				? (ISSUE_STATUS_LABELS[v as IssueStatus] ?? String(v))
				: String(v),
	unknown: (key) => {
		throw new SaidRefused(
			"SAID_KEY_UNKNOWN",
			`"${key}" is not in @forge/contracts/said-keys`,
		);
	},
};

/** The English sentence a `Said` reads as: the text core sends beside it for the CLI, MCP and agents. */
export function sayEn(s: Said): string {
	checked(s.key, s.vars);
	return renderSaid(s, ENGLISH);
}

/** Words a person or a run wrote, carried as written. */
export const verbatim = (text: string): Said => say("standing.text", { text });

/** Every key and its declared var kinds, for the tests that hold a reader to the whole registry. */
export const SAID_ENTRIES = ENTRIES;

/** A `Said` on the wire or in a stored payload: a key the registry holds and values of the kinds it declares. */
export const saidSchema: z.ZodType<Said> = z.lazy(() =>
	z
		.strictObject({
			key: z.string(),
			vars: z
				.record(
					z.string(),
					z.union([
						z.string(),
						z.number(),
						z.null(),
						saidSchema,
						z.array(saidSchema),
					]),
				)
				.optional(),
		})
		.superRefine((v, ctx) => {
			try {
				checked(v.key, v.vars as Record<string, SaidValue> | undefined);
			} catch (err) {
				ctx.addIssue({ code: "custom", message: (err as Error).message });
			}
		}),
) as z.ZodType<Said>;

/**
 * Where a value's English and what it said disagree: every `says` an object carries is walked, each
 * sentence must pass `saidSchema`, and the English field beside it (`act.label` for a blocker's act)
 * must be exactly that sentence's English, null where it said nothing. Empty when they all agree; the
 * check a producer's tests hold its whole output to.
 */
export function saidDisagreements(value: unknown, path = "$"): string[] {
	const out: string[] = [];
	const walk = (v: unknown, p: string): void => {
		if (Array.isArray(v)) {
			v.forEach((x, i) => walk(x, `${p}[${i}]`));
			return;
		}
		if (typeof v !== "object" || v === null) return;
		const o = v as Record<string, unknown>;
		const says = o.says;
		if (typeof says === "object" && says !== null && !Array.isArray(says)) {
			for (const [k, s] of Object.entries(says)) {
				const beside = o[k];
				const en =
					k === "act" && typeof beside === "object" && beside !== null
						? (beside as { label?: unknown }).label
						: beside;
				if (s === null || s === undefined) {
					if (typeof en === "string" && en !== "")
						out.push(`${p}.${k}: said nothing beside ${JSON.stringify(en)}`);
					continue;
				}
				const parsed = saidSchema.safeParse(s);
				if (!parsed.success) {
					out.push(
						`${p}.says.${k}: ${parsed.error.issues[0]?.message ?? "not a said sentence"}`,
					);
					continue;
				}
				const said = sayEn(parsed.data);
				if (en !== undefined && en !== null && said !== en)
					out.push(
						`${p}.${k}: says ${JSON.stringify(said)} beside ${JSON.stringify(en)}`,
					);
			}
		}
		for (const [k, x] of Object.entries(o))
			if (k !== "says") walk(x, `${p}.${k}`);
	};
	walk(value, path);
	return out;
}
