// What a stored chat answer can be shared as, read off its own blocks: an answer holding a report
// block is shared as that message, and a turn that ran a report template as the template's output,
// named `<templateId>:<runId>,<runId>` the way core's template-output source reads it back
// (`packages/core/src/reports/template-share-source.ts:templateOutputSubject`). Anything else offers
// no share at all.

import type { ShareSubjectKind } from "@forge/contracts/shares";

export interface ShareSubject {
  kind: ShareSubjectKind;
  id: string;
}

interface StoredBlock {
  type?: unknown;
  toolCall?: { name?: unknown; output?: unknown; isError?: unknown } | undefined;
}

const TEMPLATE_TOOL = "forge_template";

/** A tool's captured output, read back as the value it returned; a string that is not JSON is none. */
function decoded(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return null;
  }
}

/** The template output a `forge_template` call answered with: its template and its runs, in order. */
function templateOutputOf(block: StoredBlock): string | null {
  const call = block.toolCall;
  if (block.type !== "tool" || !call || call.isError === true) return null;
  if (typeof call.name !== "string" || !call.name.endsWith(TEMPLATE_TOOL)) return null;
  const document = (decoded(call.output) as { document?: unknown } | null)?.document as
    | { templateId?: unknown; runs?: unknown }
    | undefined;
  if (!document || typeof document.templateId !== "string" || !Array.isArray(document.runs)) return null;
  const runIds = document.runs.map((r) => (r as { runId?: unknown })?.runId);
  if (runIds.length === 0 || !runIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
    return null;
  }
  return `${document.templateId}:${runIds.join(",")}`;
}

/** The subject a stored assistant message is shared as, or null when it holds nothing to share. */
export function shareSubjectOf(message: {
  id: string;
  role: string;
  blocks?: readonly unknown[] | null | undefined;
}): ShareSubject | null {
  if (message.role !== "assistant") return null;
  const blocks = (message.blocks ?? []).filter(
    (b): b is StoredBlock => b !== null && typeof b === "object",
  );
  if (blocks.some((b) => b.type === "visual")) return { kind: "message", id: message.id };
  const outputs = blocks.map(templateOutputOf).filter((s): s is string => s !== null);
  const last = outputs.at(-1);
  return last ? { kind: "template-output", id: last } : null;
}
