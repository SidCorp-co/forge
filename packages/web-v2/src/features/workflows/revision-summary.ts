import type { RevisionChanges } from "@forge/contracts/workflows";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";

const SHOWN = 3;

function named(t: Copy, verb: ProductCopyKey, names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, SHOWN).join(", ");
  const more = names.length > SHOWN ? t("workflows.rev.more", { n: names.length - SHOWN }) : "";
  return t(verb, { names: `${shown}${more}` });
}

const lines = (t: Copy, n: number, verb: "adds" | "removes" | "changes") =>
  n === 0 ? null : t(`workflows.rev.${verb}Lines.${n === 1 ? "one" : "many"}` as ProductCopyKey, { n });

/** One line of what a revision changed against the one before it, from core's diff; null where there is none to say. */
export function revisionSummary(changes: RevisionChanges | null, first: boolean, t: Copy): string | null {
  if (!changes) return first ? t("workflows.rev.first") : null;
  const { steps, edges } = changes;
  const parts = [
    named(t, "workflows.rev.adds", steps.added),
    named(t, "workflows.rev.removes", steps.removed),
    named(t, "workflows.rev.rewords", steps.changed),
    lines(t, edges.added, "adds"),
    lines(t, edges.removed, "removes"),
    lines(t, edges.changed, "changes"),
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return t("workflows.rev.none");
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
