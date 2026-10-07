import type { RevisionChanges } from "@forge/contracts/workflows";

const SHOWN = 3;

function named(verb: string, names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, SHOWN).join(", ");
  const more = names.length > SHOWN ? ` and ${names.length - SHOWN} more` : "";
  return `${verb} ${shown}${more}`;
}

const lines = (n: number, verb: string) => (n === 0 ? null : `${verb} ${n} ${n === 1 ? "line" : "lines"}`);

/** One line of what a revision changed against the one before it, from core's diff; null where there is none to say. */
export function revisionSummary(changes: RevisionChanges | null, first: boolean): string | null {
  if (!changes) return first ? "First draft of the design." : null;
  const { steps, edges } = changes;
  const parts = [
    named("Adds", steps.added),
    named("removes", steps.removed),
    named("rewords", steps.changed),
    lines(edges.added, "adds"),
    lines(edges.removed, "removes"),
    lines(edges.changed, "changes"),
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "No change to the steps or lines.";
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
