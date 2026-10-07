/**
 * What an `issue.updated` row records: one entry per path a write moved, never a snapshot. A
 * document field is walked key by key and index by index. Every entry is invertible (`set` carries
 * both values, `add` the new one, `remove` the old one); a `set` with no `before` is a converted
 * snapshot row whose writer did not record what it replaced. Migration
 * `0344_an_issue_update_records_what_changed` is the SQL twin of `diffFieldValue`, ordering keys
 * and indices identically.
 */

/** `[field, ...keys]`: an object key is a string, an array index a number. */
type FieldPath = [string, ...(string | number)[]];

type FieldChange =
	| { path: FieldPath; op: "set"; before?: unknown; after: unknown }
	| { path: FieldPath; op: "add"; after: unknown }
	| { path: FieldPath; op: "remove"; before: unknown };

/** The payload of an `issue.updated` row. */
interface IssueUpdatedPayload {
	/** The fields at least one change sits under, in the order the writer listed them. */
	fields: string[];
	changes: FieldChange[];
	/**
	 * Converted rows only: a field's whole value before this row, where the previous row naming the
	 * field does not give it — the first row for that field, or one after a write nothing recorded.
	 */
	anchor?: Record<string, unknown>;
	/** Converted rows only: fields the snapshot writer listed whose value did not move. */
	unchanged?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value as it is stored: a `Date` is its ISO string and an `undefined` key is no key. */
function asStored(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameStored(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => sameStored(v, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const ka = Object.keys(a);
		if (ka.length !== Object.keys(b).length) return false;
		return ka.every((k) => k in b && sameStored(a[k], b[k]));
	}
	return false;
}

/** Keys in the order the SQL twin walks them: code-unit order, `COLLATE "C"` there. */
function unionKeys(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): string[] {
	return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) =>
		x < y ? -1 : x > y ? 1 : 0,
	);
}

function walk(
	path: FieldPath,
	a: unknown,
	b: unknown,
	out: FieldChange[],
): void {
	if (sameStored(a, b)) return;
	if (isPlainObject(a) && isPlainObject(b)) {
		for (const key of unionKeys(a, b)) {
			const at: FieldPath = [...path, key];
			if (!(key in b)) out.push({ path: at, op: "remove", before: a[key] });
			else if (!(key in a)) out.push({ path: at, op: "add", after: b[key] });
			else walk(at, a[key], b[key], out);
		}
		return;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
			const at: FieldPath = [...path, i];
			if (i >= b.length) out.push({ path: at, op: "remove", before: a[i] });
			else if (i >= a.length) out.push({ path: at, op: "add", after: b[i] });
			else walk(at, a[i], b[i], out);
		}
		return;
	}
	out.push({ path, op: "set", before: a, after: b });
}

/** The changes between two stored values of one field; none when they are equal. */
export function diffFieldValue(
	field: string,
	before: unknown,
	after: unknown,
): FieldChange[] {
	const out: FieldChange[] = [];
	walk([field], asStored(before) ?? null, asStored(after) ?? null, out);
	return out;
}

/**
 * The payload an update records, or `null` when it moved nothing — a write that changes nothing
 * records nothing.
 */
export function issueUpdatedPayload(
	fields: readonly string[],
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): IssueUpdatedPayload | null {
	const changes: FieldChange[] = [];
	const moved: string[] = [];
	for (const field of fields) {
		const found = diffFieldValue(field, before[field], after[field]);
		if (found.length === 0) continue;
		moved.push(field);
		changes.push(...found);
	}
	return changes.length === 0 ? null : { fields: moved, changes };
}

/** `sessionContext.lease.history[3]`: a path as a person reads it. */
export function formatFieldPath(path: FieldPath): string {
	const [field, ...rest] = path;
	return rest.reduce<string>(
		(s, k) => (typeof k === "number" ? `${s}[${k}]` : `${s}.${k}`),
		field,
	);
}

/** Whether a stored payload is the shape this module writes. */
export function isIssueUpdatedPayload(
	value: unknown,
): value is IssueUpdatedPayload {
	return (
		isPlainObject(value) &&
		Array.isArray(value.fields) &&
		value.fields.every((f) => typeof f === "string") &&
		Array.isArray(value.changes)
	);
}

/** Whether a stored payload is the pre-0344 snapshot shape, `{fields, before, after}`, not yet converted. */
export function isSnapshotPayload(value: unknown): boolean {
	return (
		isPlainObject(value) &&
		!("changes" in value) &&
		("before" in value || "after" in value)
	);
}

/**
 * A pre-0344 snapshot payload read as the changes it made, so a row the boot backfill has not
 * reached yet (ISS-124) reads in the one shape. It is the TypeScript twin of migration 0344's
 * `forge_issue_update_convert` for one row: a field listed with no `before` becomes a `set`
 * carrying only `after`, and a field whose value did not move is listed under `unchanged`. The one
 * difference is `anchor`, which the chain gives the stored form and a single row cannot: this
 * carries every `before` the row held, a superset of what the chain would keep. Throws, naming
 * what is wrong, on a payload that is not the snapshot shape.
 */
export function convertSnapshotPayload(
	payload: unknown,
): Record<string, unknown> {
	if (!isPlainObject(payload)) {
		throw new Error(
			"an issue.updated payload must be the {fields, before, after} object a snapshot row held",
		);
	}
	const { fields, before, after } = payload;
	if (
		!Array.isArray(fields) ||
		!fields.every((f): f is string => typeof f === "string")
	) {
		throw new Error(
			'an issue.updated snapshot\'s "fields" must be an array of field names',
		);
	}
	if (!isPlainObject(before) || !isPlainObject(after)) {
		throw new Error(
			'an issue.updated snapshot\'s "before" and "after" must both be objects keyed by field',
		);
	}
	const changes: FieldChange[] = [];
	const moved: string[] = [];
	const unchanged: string[] = [];
	const anchor: Record<string, unknown> = {};
	for (const field of fields) {
		if (!(field in after)) {
			throw new Error(
				`field "${field}" is listed in "fields" with no value in "after"`,
			);
		}
		let found: FieldChange[];
		if (field in before) {
			anchor[field] = before[field];
			found = diffFieldValue(field, before[field], after[field]);
		} else {
			found = [{ path: [field], op: "set", after: asStored(after[field]) }];
		}
		if (found.length === 0) unchanged.push(field);
		else {
			moved.push(field);
			changes.push(...found);
		}
	}
	const {
		fields: _f,
		before: _b,
		after: _a,
		...rest
	} = payload as Record<string, unknown>;
	const out: Record<string, unknown> = { ...rest, fields: moved, changes };
	if (Object.keys(anchor).length > 0) out.anchor = anchor;
	if (unchanged.length > 0) out.unchanged = unchanged;
	return out;
}

/** A stored `issue.updated` payload in the one shape: a snapshot row read as its changes, any other as stored. */
export function issueUpdatedAsChanges(payload: unknown): unknown {
	return isSnapshotPayload(payload) ? convertSnapshotPayload(payload) : payload;
}
