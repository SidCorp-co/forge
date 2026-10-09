"use client";

import { builtinReportTemplate } from "@forge/contracts/report-template-builtins";
import type { ReportDocument, TemplateNarrativeSlot } from "@forge/contracts/report-templates";
import type { ShareSnapshot } from "@forge/contracts/shares";
import type { BlockSource } from "@forge/contracts/visual-blocks";
import { useQuery } from "@tanstack/react-query";
import { Markdown, Skeleton } from "@/design";
import { ApiError } from "@/lib/api/client";
import { type SourceFacts, VisualBlockProvider, VisualBlockView } from "@/features/visual-blocks";
import { useBlockInstants } from "@/features/visual-blocks/instants";
import { readProseInstants } from "@/lib/i18n/instants";
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

/** The frozen query and read time of each run the answer holds, keyed the way a block names its source. */
function factsOf(document: ReportDocument): (source: BlockSource) => SourceFacts | undefined {
  return (source) => {
    if (!("runId" in source)) return undefined;
    const run = document.runs.find((r) => r.runId === source.runId);
    return run ? { queryId: run.queryId, asOf: run.asOf, params: run.params } : undefined;
  };
}

/** The template id a frozen chat answer carries (`packages/core/src/reports/share-source.ts`). */
const CHAT_ANSWER = "chat-answer";

/**
 * What a document is called: its own title (a shared chat answer's question), else its built-in
 * template's title. Never a template id: a chat answer frozen before it carried its question is a
 * "Shared answer".
 */
export function documentTitle(document: Pick<ReportDocument, "templateId" | "title">): string {
  if (document.title?.trim()) return document.title;
  const template = builtinReportTemplate(document.templateId);
  if (template) return template.title;
  return document.templateId === CHAT_ANSWER ? "Shared answer" : "Shared report";
}

/**
 * A report document as it reads: a chat answer's reply, the narrative slots someone wrote, then each
 * block over the runs it names, in order. Where the document is a kept report that core exports,
 * `onTableCsv` gives each table block a "Download CSV" by its index in the document; a share page has
 * none.
 */
export function ReportDocumentBody({ document, onTableCsv }: { document: ReportDocument; onTableCsv?: (blockIndex: number) => void }) {
  const instants = useBlockInstants();
  const narrative = NARRATIVE.filter(({ slot }) => document.narrative[slot]?.trim());
  return (
    <>
      {document.reply?.trim() && (
        // a reader may not be a member: a link in the reply is drawn as its words and leads nowhere
        <section className="border-b border-line py-5" data-testid="shared-reply">
          <Markdown inert>{readProseInstants(document.reply, instants)}</Markdown>
        </section>
      )}
      {narrative.map(({ slot, label }) => (
        <section key={slot} className="border-b border-line py-5">
          <h2 className="fg-body-sm font-semibold text-fg">{label}</h2>
          <p className="fg-body-sm mt-1 whitespace-pre-wrap text-fg">{readProseInstants(document.narrative[slot] ?? "", instants)}</p>
        </section>
      ))}
      {/* No projectSlug: a viewer may not be a member, so a ref reads as its key and links nowhere. */}
      <VisualBlockProvider value={{ projectSlug: undefined, sourceFacts: factsOf(document) }}>
        {document.blocks.map((block, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the document's block order is fixed
          <section key={i} className="border-b border-line py-5">
            <VisualBlockView block={block} onCsv={onTableCsv ? () => onTableCsv(i) : undefined} />
          </section>
        ))}
      </VisualBlockProvider>
    </>
  );
}

export function SharedAnswerView({ snapshot }: { snapshot: ShareSnapshot }) {
  const { document } = snapshot;
  const instants = useBlockInstants();
  return (
    <article className="flex flex-col">
      <header className="border-b border-line pb-5">
        <p className="fg-caption text-subtle">Shared answer · read-only snapshot</p>
        <h1 className="fg-h3 mt-1 font-semibold text-fg">{documentTitle(document)}</h1>
        <p className="fg-caption mt-1 text-subtle">
          {snapshot.audience === "members" ? "Shared with the project's members" : "Shared by link"} ·
          available until {instants.instant(snapshot.expiresAt)}
        </p>
      </header>
      <ReportDocumentBody document={document} />
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
