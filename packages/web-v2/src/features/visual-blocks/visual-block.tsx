"use client";

import { checkBlock, isVisualBlockKind, type VisualBlockKind } from "@forge/contracts/visual-blocks";
import { BLOCK_RENDERERS, type BlockRenderer } from "./registry";
import { SourceNote } from "./source-note";

/** What a stored block says its kind is, as a word a reader can be told. */
function kindOf(raw: unknown): string {
  const kind = raw !== null && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (typeof kind === "string" && kind.length > 0) return kind;
  return kind === undefined ? "nameless" : JSON.stringify(kind);
}

/** A block this screen cannot draw, named. It is never left out: a vanished block reads as an answer that was never given. */
export function UnsupportedBlock({ kind }: { kind: string }) {
  return (
    <p className="text-[12.5px] text-muted" data-testid="visual-block-unsupported" data-kind={kind}>
      This answer has a {kind} block this screen cannot show.
    </p>
  );
}

function RefusedBlock({ kind, reasons }: { kind: string; reasons: string[] }) {
  return (
    <div className="text-[12.5px] text-muted" data-testid="visual-block-refused" data-kind={kind}>
      <p>This answer has a {kind} block that does not match its shape, so it is not drawn.</p>
      <ul className="mt-1 list-disc pl-5 font-mono text-[11px] text-subtle">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function Frame({ kind, title, children }: { kind: string; title?: string | undefined; children: React.ReactNode }) {
  return (
    <figure className="m-0 my-1 min-w-0" data-testid="visual-block" data-kind={kind}>
      {title && <figcaption className="mb-1 text-[12.5px] font-semibold text-fg">{title}</figcaption>}
      {children}
    </figure>
  );
}

/**
 * One stored `visual` block, drawn through the registry. A kind the contract does not know, a kind
 * with no renderer here, and a block that fails its kind's check are each drawn by name; none is
 * dropped. A drawn block shows its source: the query and the moment it was read.
 */
export function VisualBlockView({ block: raw }: { block: unknown }) {
  const kind = kindOf(raw);
  if (!isVisualBlockKind(kind) || !BLOCK_RENDERERS[kind]) return <UnsupportedBlock kind={kind} />;
  const checked = checkBlock(raw);
  if (!checked.ok) return <RefusedBlock kind={kind} reasons={checked.refusals.map((r) => r.message)} />;
  const Renderer = BLOCK_RENDERERS[kind] as BlockRenderer<VisualBlockKind>;
  const block = checked.block;
  return (
    <Frame kind={kind} title={block.title}>
      <Renderer block={block as never} />
      <SourceNote source={block.source} />
    </Frame>
  );
}
