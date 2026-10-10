import { isValidElement, type ReactNode } from "react";

/* Keys for lists without ids. Pure, so a server component can key its rows too. */

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
