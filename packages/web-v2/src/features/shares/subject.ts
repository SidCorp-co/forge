// What a stored chat answer is shared as. Any message of an assistant turn — the reply, a block the
// turn posted above it, the partial it posted while it worked — shares the whole turn: core freezes
// the question, the reply and every block (`packages/core/src/reports/share-source.ts`). A person's
// message, and a turn's recorded silence, offer no share.

import { TEMPLATE_NARRATIVE_SLOTS, type TemplateNarrativeSlot } from "@forge/contracts/report-templates";
import type { ShareSubjectKind } from "@forge/contracts/shares";

/**
 * What the web shares: a chat answer or a kept status report. A template's output is shared over
 * REST (`template-output`), never offered here: in a thread the whole turn is shared instead.
 */
export interface ShareSubject {
  kind: Exclude<ShareSubjectKind, "template-output">;
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

/** What a `forge_template` call answered with: its template, its runs in order, its narrative and each block's finding. */
interface TemplateOutput {
  templateId: string;
  runIds: string[];
  narrative: Record<string, unknown>;
  findings: string[];
}

function templateOutputOf(block: StoredBlock): TemplateOutput | null {
  const call = block.toolCall;
  if (block.type !== "tool" || !call || call.isError === true) return null;
  if (typeof call.name !== "string" || !call.name.endsWith(TEMPLATE_TOOL)) return null;
  const document = (decoded(call.output) as { document?: unknown } | null)?.document as
    | { templateId?: unknown; runs?: unknown; narrative?: unknown; blocks?: unknown }
    | undefined;
  if (!document || typeof document.templateId !== "string" || !Array.isArray(document.runs)) return null;
  const runIds = document.runs.map((r) => (r as { runId?: unknown })?.runId);
  if (runIds.length === 0 || !runIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
    return null;
  }
  const narrative = document.narrative !== null && typeof document.narrative === "object" ? (document.narrative as Record<string, unknown>) : {};
  const findings = (Array.isArray(document.blocks) ? document.blocks : []).map((b) => {
    const finding = (b as { finding?: unknown } | null)?.finding;
    return typeof finding === "string" ? finding : "";
  });
  return { templateId: document.templateId, runIds, narrative, findings };
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
  /** Each block's one-line finding, in order; "" where a block has none. */
  findings: string[];
}

/**
 * The template run an answer can be saved as: its last template output's template and runs, with
 * the narrative slots that output carries written and each block's finding; a blank slot is left
 * out, never kept empty. Core judges the narrative and findings against the runs again when it keeps
 * the report.
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
  return { templateId: last.templateId, runIds: last.runIds, narrative, findings: last.findings };
}

/** The subject a stored message is shared as, or null when it is no part of an answer. */
export function shareSubjectOf(message: {
  id: string;
  role: string;
  content?: string | null | undefined;
  silenceReason?: string | null | undefined;
  blocks?: readonly unknown[] | null | undefined;
}): ShareSubject | null {
  if (message.role !== "assistant" || message.silenceReason) return null;
  const said = (message.content ?? "").trim() !== "";
  const drew = (message.blocks ?? []).some(
    (b) => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "visual",
  );
  return said || drew ? { kind: "message", id: message.id } : null;
}
