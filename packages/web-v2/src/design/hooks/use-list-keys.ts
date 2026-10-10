"use client";

import { useState } from "react";

/** Keys for an editable list whose rows carry no id of their own. */
export interface ListKeys {
  /** One key per row, in row order. */
  keys: string[];
  /** Call beside the change that appends a row. */
  added: () => void;
  /** Call beside the change that removes row `index`. */
  removed: (index: number) => void;
}

type Minted = { keys: string[]; next: number };

/** Pads or trims `minted` to `count` rows. Pure: new keys come from the counter in state. */
function fit(minted: Minted, count: number): Minted {
  if (minted.keys.length === count) return minted;
  if (minted.keys.length > count) return { keys: minted.keys.slice(0, count), next: minted.next };
  const pad = count - minted.keys.length;
  return { keys: [...minted.keys, ...Array.from({ length: pad }, (_, j) => `row-${minted.next + j}`)], next: minted.next + pad };
}

/**
 * Stable keys for an editable list without ids (the useFieldArray idea, without the form library).
 * A key is minted when a row is added and dropped with its row, so the rows around a removal keep
 * theirs. A list replaced from outside (a reset, a reload) is padded or trimmed to its new length.
 */
export function useListKeys(count: number): ListKeys {
  const [minted, setMinted] = useState<Minted>(() => fit({ keys: [], next: 0 }, count));
  const shown = fit(minted, count);
  return {
    keys: shown.keys,
    added: () => setMinted(fit(shown, count + 1)),
    removed: (index) => setMinted({ keys: shown.keys.filter((_, i) => i !== index), next: shown.next }),
  };
}
