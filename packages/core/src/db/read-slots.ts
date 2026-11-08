// The per-id slots of `db/read-memo.ts`, apart so the memo stays one file of its rules.

/**
 * What each id is held as under each key of a memo: one map a key, so an ask finds its ids without
 * building a string for each (ISS-1070 r11: a person's twelve projects asked about 50 thousand ids a
 * read, each a `key\0id` string built two or three times).
 */
const slotsByMemo = new WeakMap<
  Map<string, Promise<unknown>>,
  Map<string, Map<string, Promise<unknown>>>
>();

export function slotsOf(
  memo: Map<string, Promise<unknown>>,
  key: string,
): Map<string, Promise<unknown>> {
  let byKey = slotsByMemo.get(memo);
  if (!byKey) {
    byKey = new Map();
    slotsByMemo.set(memo, byKey);
  }
  let slots = byKey.get(key);
  if (!slots) {
    slots = new Map();
    byKey.set(key, slots);
  }
  return slots;
}
