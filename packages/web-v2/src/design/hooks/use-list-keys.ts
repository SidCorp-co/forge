import { isValidElement, type ReactNode, useState } from "react";

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

/** Pairs a list with its keys, so a row is keyed by its minted key rather than its position. */
export function keyedRows<T>(rows: readonly T[], keys: readonly string[]): { key: string; row: T; index: number }[] {
  if (keys.length !== rows.length) {
    throw new Error(`keyedRows: ${String(rows.length)} rows but ${String(keys.length)} keys; pass useListKeys(rows.length)`);
  }
  return rows.map((row, index) => ({ key: keys[index] ?? "", row, index }));
}

/**
 * Keys for a read-only list that never reorders and has no ids: each item is keyed by its content,
 * and a repeat by how many times that content came before it.
 */
export function keyedByContent<T>(items: readonly T[], contentOf: (item: T) => string = (item) => JSON.stringify(item)): { key: string; item: T; index: number }[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const content = contentOf(item);
    const nth = seen.get(content) ?? 0;
    seen.set(content, nth + 1);
    return { key: `${content}#${String(nth)}`, item, index };
  });
}

/** What a node reads as, for a key: its text, else its own key, else its element type's name. */
function nodeContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (isValidElement(node)) {
    if (node.key !== null) return `key:${node.key}`;
    return typeof node.type === "string" ? node.type : (node.type as { name?: string }).name ?? "element";
  }
  return typeof node;
}

/** keyedByContent for a line of nodes (a facts line): each keyed by what it reads as. */
export function keyedNodes(nodes: readonly ReactNode[]): { key: string; item: ReactNode; index: number }[] {
  return keyedByContent(nodes, nodeContent);
}
