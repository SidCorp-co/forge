// What a stored chat answer can be shared as, read off its own blocks: an answer holding a report
// block is shared as that message, and a turn that ran a report template as the template's output,
// named `<templateId>:<runId>,<runId>` the way core's template-output source reads it back
// (`packages/core/src/reports/template-share-source.ts:templateOutputSubject`). Anything else offers
// no share at all.

import { TEMPLATE_NARRATIVE_SLOTS, type TemplateNarrativeSlot } from "@forge/contracts/report-templates";
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

/** What a `forge_template` call answered with: its template, its runs in order and its narrative. */
interface TemplateOutput {
  templateId: string;
  runIds: string[];
  narrative: Record<string, unknown>;
}

function templateOutputOf(block: StoredBlock): TemplateOutput | null {
  const call = block.toolCall;
  if (block.type !== "tool" || !call || call.isError === true) return null;
  if (typeof call.name !== "string" || !call.name.endsWith(TEMPLATE_TOOL)) return null;
  const document = (decoded(call.output) as { document?: unknown } | null)?.document as
    | { templateId?: unknown; runs?: unknown; narrative?: unknown }
    | undefined;
  if (!document || typeof document.templateId !== "string" || !Array.isArray(document.runs)) return null;
  const runIds = document.runs.map((r) => (r as { runId?: unknown })?.runId);
  if (runIds.length === 0 || !runIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
    return null;
  }
  const narrative = document.narrative !== null && typeof document.narrative === "object" ? (document.narrative as Record<string, unknown>) : {};
  return { templateId: document.templateId, runIds, narrative };
}

/** The template outputs of a stored assistant message, in the order its turn made them. */
function templateOutputsIn(message: { role: string; blocks?: readonly unknown[] | null | undefined }): TemplateOutput[] {
  if (message.role !== "assistant") return [];
  return (message.blocks ?? [])
    .filter((b): b is StoredBlock => b !== null && typeof b === "object")
    .map(templateOutputOf)
    .filter((o): o is TemplateOutput => o !== null);
}

/** What "Save report" keeps of an answer (`POST .../status/reports`), or null where it ran no template. */
export interface TemplateSave {
  templateId: string;
  runIds: string[];
  narrative: Partial<Record<TemplateNarrativeSlot, string>>;
}

/**
 * The template run an answer can be saved as: its last template output's template and runs, with
 * the narrative slots that output carries written; a blank slot is left out, never kept empty. Core
 * judges the narrative against the runs again when it keeps the report.
 */
export function templateSaveOf(message: {
  role: string;
  blocks?: readonly unknown[] | null | undefined;
}): TemplateSave | null {
  const last = templateOutputsIn(message).at(-1);
  if (!last) return null;
  const narrative: TemplateSave["narrative"] = {};
  for (const slot of TEMPLATE_NARRATIVE_SLOTS) {
    const text = last.narrative[slot];
    if (typeof text === "string" && text.trim()) narrative[slot] = text;
  }
  return { templateId: last.templateId, runIds: last.runIds, narrative };
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
  const last = templateOutputsIn(message).at(-1);
  return last ? { kind: "template-output", id: `${last.templateId}:${last.runIds.join(",")}` } : null;
}
