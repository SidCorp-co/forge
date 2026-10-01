import {
	buildDocumentPatch,
	canonicalJson,
	formatPath,
	isPlainObject,
	patchLeafPaths,
	readPath,
	rebaseDocumentDraft,
} from "@forge/contracts/document-patch";
import { documentRefusals, type Refusal } from "@/lib/api/refusals";
import type { V1Document } from "./config-types";

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

export const isStaleBase = (err: unknown) => documentRefusals(err).some((r) => r.code === STALE_BASE);

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

export function placeRefusals(
	document: unknown,
	refusals: readonly Refusal[],
): Map<string, Refusal[]> {
	const placed = new Map<string, Refusal[]>();
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
	contested: boolean;
}

const leaves = (from: unknown, to: unknown) => patchLeafPaths(buildDocumentPatch(from, to).patch);

function overlaps(a: readonly string[], b: readonly string[]): boolean {
	const shared = Math.min(a.length, b.length);
	for (let at = 0; at < shared; at += 1) if (a[at] !== b[at]) return false;
	return true;
}

export function movedSince(read: unknown, fresh: unknown, held: unknown): MovedValue[] {
	const mine = leaves(read, held);
	return leaves(read, fresh).map((path) => ({
		path: formatPath(path),
		read: readPath(read, path),
		stored: readPath(fresh, path),
		contested: mine.some((edit) => overlaps(edit, path)),
	}));
}

export function reapply(read: unknown, held: unknown, fresh: unknown): V1Document {
	return rebaseDocumentDraft({ read: read ?? {}, held, fresh }).draft;
}

export const sameDocument = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export function schemaUrl(kind: string): string {
	return `https://forge.sidcorp.co/schemas/${kind}-v1.json`;
}

export const REMOVE = Symbol("remove");

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
