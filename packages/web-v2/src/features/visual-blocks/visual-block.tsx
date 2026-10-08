"use client";

import { checkBlock, isVisualBlockKind, type VisualBlockKind } from "@forge/contracts/visual-blocks";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useVisualBlockContext } from "./context";
import { BLOCK_RENDERERS, type BlockRenderer } from "./registry";
import { SourceNote } from "./source-note";
import { UnsupportedBlock } from "./unsupported";

/** What a stored block says its kind is, as a word a reader can be told. */
function kindOf(raw: unknown): string {
  const kind = raw !== null && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (typeof kind === "string" && kind.length > 0) return kind;
  return kind === undefined ? "nameless" : JSON.stringify(kind);
}

function RefusedBlock({ kind, why = "does not match its shape", reasons }: { kind: string; why?: string; reasons: string[] }) {
  return (
    <div className="text-[12.5px] text-muted" data-testid="visual-block-refused" data-kind={kind}>
      <p>
        This answer has a {kind} block that {why}, so it is not drawn.
      </p>
      <ul className="mt-1 list-disc pl-5 font-mono text-[11px] text-subtle">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

/** The kinds whose drawing gains from room: each offers to open at full width. A figure row and a status list read the same at any width. */
const WIDENS: ReadonlySet<VisualBlockKind> = new Set(["table", "chart", "flow", "timeline"]);

function Caption({ title, action }: { title?: string | undefined; action?: React.ReactNode }) {
  if (!title && !action) return null;
  return (
    <figcaption className="mb-1 flex min-w-0 items-baseline justify-between gap-3">
      <span className="min-w-0 text-[12.5px] font-semibold text-fg">{title}</span>
      {action}
    </figcaption>
  );
}

/**
 * One block's frame: its title, its drawing, its source. Every screen that shows a block, the chat
 * panel, the full-page thread and a share page, draws it through this one frame, so the same content
 * is drawn the same way and only the width differs. A kind that gains from room offers to open the
 * same drawing at full width in the shared dialog.
 */
function Frame({ kind, title, children }: { kind: VisualBlockKind; title?: string | undefined; children: React.ReactNode }) {
  const [wide, setWide] = useState(false);
  const action = WIDENS.has(kind) ? (
    <button
      type="button"
      className="flex-none text-[11.5px] font-medium text-link hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      onClick={() => setWide(true)}
      data-testid="visual-block-open-wide"
    >
      Open wide
    </button>
  ) : undefined;
  return (
    <figure className="m-0 my-1 min-w-0 max-w-full" data-testid="visual-block" data-kind={kind}>
      <Caption title={title} action={action} />
      {children}
      {wide && (
        <Dialog open onOpenChange={(next) => !next && setWide(false)}>
          <DialogContent
            className="flex max-h-[90vh] w-[min(96vw,1200px)] max-w-none flex-col gap-2 overflow-y-auto bg-app p-5 sm:max-w-none"
            data-testid="visual-block-wide"
          >
            <DialogTitle className="pr-8 text-[13px] font-semibold text-fg">{title ?? "Answer"}</DialogTitle>
            <div className="min-w-0">{children}</div>
          </DialogContent>
        </Dialog>
      )}
    </figure>
  );
}

/**
 * One stored `visual` block, drawn through the registry. A kind the contract does not know, a kind
 * with no renderer here, and a block that fails its kind's check are each drawn by name; none is
 * dropped. A drawn block shows its source: the query and the moment it was read; a block of a run
 * whose query and read time this screen was not given is refused by name, never drawn untraced.
 */
export function VisualBlockView({ block: raw }: { block: unknown }) {
  const { sourceFacts } = useVisualBlockContext();
  const kind = kindOf(raw);
  if (!isVisualBlockKind(kind)) return <UnsupportedBlock kind={kind} />;
  const checked = checkBlock(raw);
  if (!checked.ok) return <RefusedBlock kind={kind} reasons={checked.refusals.map((r) => r.message)} />;
  const Renderer = BLOCK_RENDERERS[kind] as BlockRenderer<VisualBlockKind>;
  const block = checked.block;
  const facts = block.source ? sourceFacts?.(block.source) : undefined;
  if (block.source && "runId" in block.source && !facts) {
    return (
      <RefusedBlock
        kind={kind}
        why="names no read its figures came from"
        reasons={[`report run ${block.source.runId}: its query and read time were not stored with this block, so its figures cannot be traced to a read`]}
      />
    );
  }
  return (
    <Frame kind={kind} title={block.title}>
      <Renderer block={block as never} />
      <SourceNote source={block.source} facts={facts} />
    </Frame>
  );
}
