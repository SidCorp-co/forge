/**
 * The write contract for a stored settings document: a caller sends the values it read
 * (`base`) beside the keys it wants changed (`patch`), and the store applies the write whole or
 * refuses it whole. A patch is sparse — an unnamed key is untouched at any depth, an object
 * merges, an array or scalar replaces, `null` deletes — and comparison happens at the paths the
 * patch writes and nowhere else, so writers naming no common path both land from one read.
 */

export type DocumentPatch = Record<string, unknown>;

export interface PatchConflict {
	/** Dotted path, from the document root. */
	path: string;
	/** What the caller read there. */
	base: unknown;
	/** What is there now. */
	stored: unknown;
}

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys sorted at every depth, so two structurally equal values render the same string. */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isPlainObject(value)) {
		const body = Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
			.join(",");
		return `{${body}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function deepEqual(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/**
 * Equality as the store sees it: absent and `null` are one value here, because `null` is what
 * a patch sends to delete and every reader of these documents answers the same for both.
 */
export function sameStoredValue(a: unknown, b: unknown): boolean {
	if ((a === null || a === undefined) && (b === null || b === undefined))
		return true;
	return deepEqual(a, b);
}

export function applyDocumentPatch(
	current: unknown,
	patch: DocumentPatch,
): Record<string, unknown> {
	const next: Record<string, unknown> = isPlainObject(current)
		? { ...current }
		: {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
			continue;
		}
		if (isPlainObject(value)) {
			next[key] = applyDocumentPatch(next[key], value);
			continue;
		}
		next[key] = value;
	}
	return next;
}

/**
 * The paths a patch writes, each as its own SEGMENTS — a nested object is walked rather than
 * claimed. Segments and not a dotted string, because a record key may legally hold a period
 * (`mcpServers: { "team.prod": {...} }`) and joining makes it indistinguishable from nesting,
 * which reads `undefined` on both sides and lets a stale write through the compare-and-swap.
 */
export function patchLeafPaths(
	patch: DocumentPatch,
	prefix: string[] = [],
): string[][] {
	const out: string[][] = [];
	for (const [key, value] of Object.entries(patch)) {
		const path = [...prefix, key];
		if (isPlainObject(value) && Object.keys(value).length > 0) {
			out.push(...patchLeafPaths(value, path));
			continue;
		}
		if (isPlainObject(value)) continue;
		out.push(path);
	}
	return out;
}

export function readPath(document: unknown, path: readonly string[]): unknown {
	let cursor: unknown = document;
	for (const segment of path) {
		if (!isPlainObject(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return cursor;
}

/** One path as a reader sees it; a segment holding a period is quoted. */
export function formatPath(path: readonly string[]): string {
	return path.map((s) => (s.includes(".") ? JSON.stringify(s) : s)).join(".");
}

/**
 * Where the store disagrees with what the caller read, at the paths this patch writes.
 * An empty list is the write's licence to proceed.
 */
export function comparePatchBase(
	stored: unknown,
	base: unknown,
	patch: DocumentPatch,
): PatchConflict[] {
	const conflicts: PatchConflict[] = [];
	for (const path of patchLeafPaths(patch)) {
		const expected = readPath(base, path);
		const actual = readPath(stored, path);
		if (!sameStoredValue(expected, actual)) {
			conflicts.push({
				path: formatPath(path),
				base: expected,
				stored: actual,
			});
		}
	}
	return conflicts;
}

/** The patch taking `before` to `after`, beside the base it is compared against. */
export function buildDocumentPatch(
	before: unknown,
	after: unknown,
): { patch: DocumentPatch; base: Record<string, unknown> } {
	const from = isPlainObject(before) ? before : {};
	const to = isPlainObject(after) ? after : {};
	return { patch: diff(from, to), base: from };
}

function diff(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): DocumentPatch {
	const patch: DocumentPatch = {};
	for (const key of Object.keys(before)) {
		const gone = !(key in after) || after[key] === undefined;
		if (gone && !sameStoredValue(before[key], undefined)) patch[key] = null;
	}
	for (const [key, value] of Object.entries(after)) {
		if (value === undefined) continue;
		const previous = before[key];
		if (sameStoredValue(previous, value)) continue;
		if (isPlainObject(previous) && isPlainObject(value)) {
			const nested = diff(previous, value);
			if (Object.keys(nested).length > 0) patch[key] = nested;
			continue;
		}
		patch[key] = value === null ? null : value;
	}
	return patch;
}

/** One line per conflict, for a refusal that has to say what moved. */
export function describeConflicts(conflicts: PatchConflict[]): string {
	return conflicts
		.map(
			(c) =>
				`${c.path}: you read ${canonicalJson(c.base)}, it now holds ${canonicalJson(c.stored)}`,
		)
		.join("; ");
}

/** One segment path back out of what {@link formatPath} wrote — the encoding's only reader. */
export function parsePath(formatted: string): string[] {
	const out: string[] = [];
	let at = 0;
	while (at <= formatted.length) {
		if (formatted[at] === '"') {
			const closed = closingQuote(formatted, at);
			if (closed > 0) {
				out.push(JSON.parse(formatted.slice(at, closed)) as string);
				at = closed + 1;
				if (formatted[at] === ".") at += 1;
				continue;
			}
		}
		const dot = formatted.indexOf(".", at);
		if (dot < 0) {
			out.push(formatted.slice(at));
			return out;
		}
		out.push(formatted.slice(at, dot));
		at = dot + 1;
	}
	return out;
}

/** The index just past a JSON string starting at `from`, or -1 where it does not close. */
function closingQuote(text: string, from: number): number {
	for (let at = from + 1; at < text.length; at += 1) {
		if (text[at] === "\\") {
			at += 1;
			continue;
		}
		if (text[at] === '"') return at + 1;
	}
	return -1;
}

/** An edit of the person's that a rebase took the stored value over instead of keeping. */
export interface ReplacedEdit {
	path: string;
	/** What the person had there, and what replaced it. */
	typed: unknown;
	stored: unknown;
}

export interface DraftRebase {
	/** The document as it was when this draft was seeded, what is held over it now, and what
	 *  is stored now; plus the paths to take the stored value at regardless of what is held. */
	read: unknown;
	held: unknown;
	fresh: unknown;
	yielding?: readonly (readonly string[])[];
}

/**
 * A draft carried onto a fresh read of the document it was seeded from. The unsaved edits ARE a
 * patch, so replaying it keeps every one of them and takes the stored value at every path left
 * alone — the same merge the store applies to a write. `yielding` is the one exception: a path
 * named there drops the edit standing on it and comes back in `replaced`.
 */
export function rebaseDocumentDraft({
	read,
	held,
	fresh,
	yielding = [],
}: DraftRebase): { draft: Record<string, unknown>; replaced: ReplacedEdit[] } {
	const { patch } = buildDocumentPatch(read, held);
	const replaced: ReplacedEdit[] = [];
	let kept = patch;
	for (const path of yielding) {
		for (const leaf of patchLeafPaths(kept)) {
			if (!overlaps(path, leaf)) continue;
			const typed = readPath(held, leaf);
			const stored = readPath(fresh, leaf);
			if (!sameStoredValue(typed, stored))
				replaced.push({ path: formatPath(leaf), typed, stored });
			kept = withoutLeaf(kept, leaf);
		}
	}
	return { draft: applyDocumentPatch(fresh, kept), replaced };
}

/** Whether either path is the other's prefix: a yielded leaf meets an edit made above it. */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
	const shared = Math.min(a.length, b.length);
	for (let at = 0; at < shared; at += 1) if (a[at] !== b[at]) return false;
	return true;
}

/** The patch without that leaf, and without any branch the removal emptied. */
function withoutLeaf(patch: DocumentPatch, leaf: readonly string[]): DocumentPatch {
	const [head, ...rest] = leaf;
	if (head === undefined || !(head in patch)) return patch;
	const next: DocumentPatch = { ...patch };
	if (rest.length === 0) {
		delete next[head];
		return next;
	}
	const under = next[head];
	if (!isPlainObject(under)) {
		delete next[head];
		return next;
	}
	const pruned = withoutLeaf(under, rest);
	if (Object.keys(pruned).length === 0) delete next[head];
	else next[head] = pruned;
	return next;
}
