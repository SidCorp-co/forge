"use client";

import type { ReportDocument, TemplateNarrativeSlot } from "@forge/contracts/report-templates";
import type { ShareSnapshot } from "@forge/contracts/shares";
import { blockToText, checkBlock } from "@forge/contracts/visual-blocks";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/design";
import { ApiError } from "@/lib/api/client";
import { openShare } from "../api";

const NARRATIVE: readonly { slot: TemplateNarrativeSlot; label: string }[] = [
  { slot: "summary", label: "Summary" },
  { slot: "risks", label: "Risks" },
  { slot: "recommendations", label: "Recommendations" },
];

const REFUSED: Record<string, string> = {
  SHARE_NOT_AVAILABLE:
    "This link is not available. It may have expired or been revoked, or the person who shared it can no longer share from the project.",
  SHARE_TOKEN_MALFORMED: "This is not a share link. Check that the whole link was copied.",
  SHARE_SIGN_IN_REQUIRED:
    "This answer is shared with the project's members only. Sign in, then open this link again.",
  SHARE_AUDIENCE_FORBIDDEN:
    "This answer is shared with the project's members only, and your account is not one of them.",
  RATE_LIMITED: "This link is being opened too often. Try again in a minute.",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

function sourceOf(document: ReportDocument, block: unknown): string | null {
  const runId = (block as { source?: { runId?: string } }).source?.runId;
  const run = runId ? document.runs.find((r) => r.runId === runId) : undefined;
  return run ? `From the ${run.queryId} report, read ${when(run.asOf)}` : null;
}

/**
 * One block of a shared answer, drawn as its text fallback (`blockToText` of the contract), since
 * the web `visual-blocks` registry holds no renderer yet. Text only: a reference reads as its key and
 * is never a link, and nothing in the block is parsed as markup. A block whose kind this build does
 * not know is named, never dropped.
 */
function SharedBlock({ document, block }: { document: ReportDocument; block: unknown }) {
  const checked = checkBlock(block);
  if (!checked.ok) {
    const kind = (block as { kind?: unknown }).kind;
    return (
      <p className="fg-body-sm text-subtle">
        This answer has a {typeof kind === "string" ? kind : "unnamed"} block this page cannot show.
      </p>
    );
  }
  const source = sourceOf(document, checked.block);
  return (
    <figure className="m-0">
      <pre className="fg-body-sm m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-fg">
        {blockToText(checked.block)}
      </pre>
      {source && <figcaption className="fg-caption mt-2 text-subtle">{source}</figcaption>}
    </figure>
  );
}

export function SharedAnswerView({ snapshot }: { snapshot: ShareSnapshot }) {
  const { document } = snapshot;
  const narrative = NARRATIVE.filter(({ slot }) => document.narrative[slot]?.trim());
  return (
    <article className="flex flex-col">
      <header className="border-b border-line pb-5">
        <p className="fg-caption text-subtle">Shared answer · read-only snapshot</p>
        <h1 className="fg-h3 mt-1 font-semibold text-fg">Report: {document.templateId}</h1>
        <p className="fg-caption mt-1 text-subtle">
          {snapshot.audience === "members" ? "Shared with the project's members" : "Shared by link"} ·
          available until {when(snapshot.expiresAt)}
        </p>
      </header>
      {narrative.map(({ slot, label }) => (
        <section key={slot} className="border-b border-line py-5">
          <h2 className="fg-body-sm font-semibold text-fg">{label}</h2>
          <p className="fg-body-sm mt-1 whitespace-pre-wrap text-fg">{document.narrative[slot]}</p>
        </section>
      ))}
      {document.blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the snapshot's block order is fixed
        <section key={i} className="border-b border-line py-5">
          {"title" in block && block.title ? (
            <h2 className="fg-body-sm mb-2 font-semibold text-fg">{block.title}</h2>
          ) : null}
          <SharedBlock document={document} block={block} />
        </section>
      ))}
    </article>
  );
}

/** The page body of `/s/<token>`: waits for the session to be known, then opens the share once. */
export function SharedAnswer({ token, signedIn }: { token: string; signedIn: boolean | null }) {
  const opened = useQuery({
    queryKey: ["share", token, signedIn],
    queryFn: () => openShare(token, signedIn === true),
    enabled: signedIn !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  if (opened.error) {
    const code = opened.error instanceof ApiError ? opened.error.code : undefined;
    return (
      <p role="alert" className="fg-body-sm text-fg">
        {(code && REFUSED[code]) ?? "This shared answer could not be opened. Try again shortly."}
      </p>
    );
  }
  if (!opened.data) return <Skeleton className="h-40 w-full" />;
  return <SharedAnswerView snapshot={opened.data} />;
}
