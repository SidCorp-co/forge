import {
	buildDocumentPatch,
	canonicalJson,
	formatPath,
	isPlainObject,
	patchLeafPaths,
	readPath,
	rebaseDocumentDraft,
} from "@forge/contracts/document-patch";
import { ApiError } from "@/lib/api/client";
import type { ConfigRefusal, V1Document } from "./config-types";

export const STALE_BASE = "STALE_BASE";

export function pointerOf(segments: readonly (string | number)[]): string {
	return segments
		.map((s) => `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`)
		.join("");
}

export function segmentsOf(pointer: string): string[] {
	if (pointer === "") return [];
	return pointer
		.slice(1)
		.split("/")
		.map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isRefusal(row: unknown): row is ConfigRefusal {
	if (typeof row !== "object" || row === null) return false;
	const r = row as Record<string, unknown>;
	return typeof r.code === "string" && typeof r.path === "string" && typeof r.detail === "string";
}

/** The `{code, path, detail}` rows a 422 carries under `error.refusals`; none for any other error. */
export function refusalsOf(err: unknown): ConfigRefusal[] {
	if (!(err instanceof ApiError) || err.status !== 422) return [];
	const rows = (err.body as { error?: { refusals?: unknown } } | undefined)?.error?.refusals;
	return Array.isArray(rows) ? rows.filter(isRefusal) : [];
}

export const isStaleBase = (err: unknown) => refusalsOf(err).some((r) => r.code === STALE_BASE);

function childAt(value: unknown, segment: string): { found: boolean; value: unknown } {
	if (Array.isArray(value)) {
		const at = Number(segment);
		return Number.isInteger(at) && at >= 0 && at < value.length
			? { found: true, value: value[at] }
			: { found: false, value: undefined };
	}
	if (isPlainObject(value) && Object.hasOwn(value, segment)) {
		return { found: true, value: value[segment] };
	}
	return { found: false, value: undefined };
}

/** The deepest pointer along `pointer` that the document holds — where a refusal of a missing
 *  key is shown, since the key it names has no field to stand beside. */
export function nearestHeld(document: unknown, pointer: string): string {
	const held: string[] = [];
	let cursor = document;
	for (const segment of segmentsOf(pointer)) {
		const next = childAt(cursor, segment);
		if (!next.found) break;
		held.push(segment);
		cursor = next.value;
	}
	return pointerOf(held);
}

/** Each refusal filed under the pointer of the field that shows it. STALE_BASE is no field's. */
export function placeRefusals(
	document: unknown,
	refusals: readonly ConfigRefusal[],
): Map<string, ConfigRefusal[]> {
	const placed = new Map<string, ConfigRefusal[]>();
	for (const refusal of refusals) {
		if (refusal.code === STALE_BASE) continue;
		const at = nearestHeld(document, refusal.path);
		placed.set(at, [...(placed.get(at) ?? []), refusal]);
	}
	return placed;
}

export interface MovedValue {
	path: string;
	read: unknown;
	stored: unknown;
	/** The person also changed this path, so re-applying their edits replaces the stored value. */
	contested: boolean;
}

const leaves = (from: unknown, to: unknown) => patchLeafPaths(buildDocumentPatch(from, to).patch);

function overlaps(a: readonly string[], b: readonly string[]): boolean {
	const shared = Math.min(a.length, b.length);
	for (let at = 0; at < shared; at += 1) if (a[at] !== b[at]) return false;
	return true;
}

/** What another writer changed between the revision a draft was read at and the stored one. */
export function movedSince(read: unknown, fresh: unknown, held: unknown): MovedValue[] {
	const mine = leaves(read, held);
	return leaves(read, fresh).map((path) => ({
		path: formatPath(path),
		read: readPath(read, path),
		stored: readPath(fresh, path),
		contested: mine.some((edit) => overlaps(edit, path)),
	}));
}

/** The person's edits replayed over the stored document, which they then save against its revision. */
export function reapply(read: unknown, held: unknown, fresh: unknown): V1Document {
	return rebaseDocumentDraft({ read: read ?? {}, held, fresh }).draft;
}

export const sameDocument = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export function schemaUrl(kind: string): string {
	return `https://forge.sidcorp.co/schemas/${kind}-v1.json`;
}

export const REMOVE = Symbol("remove");

/** `document` with the value at `segments` replaced, or removed for {@link REMOVE}; never mutated. */
export function setAt(document: unknown, segments: readonly string[], value: unknown): unknown {
	const [head, ...rest] = segments;
	if (head === undefined) return value;
	if (Array.isArray(document)) {
		const at = Number(head);
		const next = [...document];
		if (rest.length === 0 && value === REMOVE) next.splice(at, 1);
		else next[at] = setAt(document[at], rest, value);
		return next;
	}
	const next: Record<string, unknown> = isPlainObject(document) ? { ...document } : {};
	if (rest.length === 0 && value === REMOVE) delete next[head];
	else next[head] = setAt(next[head], rest, value);
	return next;
}
