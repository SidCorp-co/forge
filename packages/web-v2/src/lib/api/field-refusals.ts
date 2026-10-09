import { namedRefusals, type Refusal } from "./refusals";

/** A refused save read onto its form: each field's plain words, and which refusals a field shows. */
export interface PlacedRefusals<F extends string> {
  /** The plain words of every refusal on `field`, joined; undefined while none is. */
  at: (field: F) => string | undefined;
  /** Whether a field shows `r`, so the line under the form leaves it out. */
  onField: (r: Refusal) => boolean;
}

/** A field owns its path and every path under it: `/criteria` owns `/criteria/2/body`, never `/criteriaFrom`. */
const owns = (path: string, refused: string) => refused === path || refused.startsWith(`${path}/`);

/**
 * Places each refusal core named for a failed save on the field whose paths own it (REQ-34 BC-18), in
 * core's own words. A failure that named no refusal places nothing, and `RefusalLine` still words it.
 */
export function placeRefusals<F extends string>(error: unknown, fields: Readonly<Record<F, readonly string[]>>): PlacedRefusals<F> {
  const names = Object.keys(fields) as F[];
  const fieldOf = (r: Refusal) => names.find((f) => fields[f].some((p) => owns(p, r.path)));
  const words = new Map<F, string[]>();
  for (const r of namedRefusals(error)) {
    const field = fieldOf(r);
    if (field !== undefined) words.set(field, [...(words.get(field) ?? []), r.detail]);
  }
  return {
    at: (field) => words.get(field)?.join(" "),
    onField: (r) => fieldOf(r) !== undefined,
  };
}
