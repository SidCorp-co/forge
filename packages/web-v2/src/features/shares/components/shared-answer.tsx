
import type { ReactNode } from "react";
import { builtinReportTemplate } from "@forge/contracts/report-template-builtins";
import type { ReportDocument, TemplateNarrativeSlot } from "@forge/contracts/report-templates";
import { isReleaseShare, type ShareReleaseSnapshot, type ShareSnapshot } from "@forge/contracts/shares";
import type { BlockSource } from "@forge/contracts/visual-blocks";
import { useQuery } from "@tanstack/react-query";
import { keyedByContent, Markdown, Skeleton } from "@/design";
import { ApiError } from "@/lib/api/client";
import { type SourceFacts, VisualBlockProvider, VisualBlockView } from "@/features/visual-blocks";
import { useBlockInstants } from "@/features/visual-blocks";
import { readProseInstants } from "@/lib/i18n/instants";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { openShare } from "../api";

const NARRATIVE: readonly TemplateNarrativeSlot[] = ["summary", "risks", "recommendations"];

/** What a refused open says, by core's refusal code; any other code reads the general failure. */
const REFUSED: Record<string, ProductCopyKey> = {
  SHARE_NOT_AVAILABLE: "shares.refused.notAvailable",
  SHARE_TOKEN_MALFORMED: "shares.refused.malformed",
  SHARE_SIGN_IN_REQUIRED: "shares.refused.signIn",
  SHARE_AUDIENCE_FORBIDDEN: "shares.refused.forbidden",
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
export function documentTitle(document: Pick<ReportDocument, "templateId" | "title">, t: Copy): string {
  if (document.title?.trim()) return document.title;
  const template = builtinReportTemplate(document.templateId);
  if (template) return template.title;
  return document.templateId === CHAT_ANSWER ? t("shares.title.answer") : t("shares.title.report");
}

/**
 * A report document as it reads: a chat answer's reply, the narrative slots someone wrote, then each
 * block over the runs it names, in order. Where the document is a kept report that core exports,
 * `onTableCsv` gives each table block a "Download CSV" by its index in the document; a share page has
 * none.
 */
export function ReportDocumentBody({ document, onTableCsv }: { document: ReportDocument; onTableCsv?: (blockIndex: number) => void }) {
  const instants = useBlockInstants();
  const t = useCopy();
  const narrative = NARRATIVE.filter((slot) => document.narrative[slot]?.trim());
  return (
    <>
      {document.reply?.trim() && (
        // a reader may not be a member: a link in the reply is drawn as its words and leads nowhere
        <section className="border-b border-line py-5" data-testid="shared-reply">
          <Markdown inert>{readProseInstants(document.reply, instants)}</Markdown>
        </section>
      )}
      {narrative.map((slot) => (
        <section key={slot} className="border-b border-line py-5">
          <h2 className="fg-body-sm font-semibold text-fg">{t(`shares.narrative.${slot}`)}</h2>
          <p className="fg-body-sm mt-1 whitespace-pre-wrap text-fg">{readProseInstants(document.narrative[slot] ?? "", instants)}</p>
        </section>
      ))}
      {/* No projectSlug: a viewer may not be a member, so a ref reads as its key and links nowhere. */}
      <VisualBlockProvider value={{ projectSlug: undefined, sourceFacts: factsOf(document) }}>
        {keyedByContent(document.blocks).map(({ key, item: block, index: i }) => (
          <section key={key} className="border-b border-line py-5">
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
  const t = useCopy();
  return (
    <article className="flex flex-col">
      <header className="border-b border-line pb-5">
        <p className="fg-caption text-subtle">{t("shares.answer.kicker")}</p>
        <h1 className="fg-h3 mt-1 font-semibold text-fg">{documentTitle(document, t)}</h1>
        <p className="fg-caption mt-1 text-subtle">
          {snapshot.audience === "members" ? t("shares.answer.members") : t("shares.answer.link")} ·{" "}
          {t("shares.answer.until", { at: instants.instant(snapshot.expiresAt) })}
        </p>
      </header>
      <ReportDocumentBody document={document} />
    </article>
  );
}

/**
 * The page body of `/s/<token>`: waits for the session to be known, then opens the share once. A
 * frozen release page is drawn by `release`, which the route hands in: the release reader lives in a
 * feature above this one, so this one cannot name it.
 */
export function SharedAnswer({
  token,
  signedIn,
  release,
}: {
  token: string;
  signedIn: boolean | null;
  release: (snapshot: ShareReleaseSnapshot) => ReactNode;
}) {
  const t = useCopy();
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
        {t((code && REFUSED[code]) || "shares.answer.openFailed")}
      </p>
    );
  }
  if (!opened.data) return <Skeleton className="h-40 w-full" />;
  return isReleaseShare(opened.data) ? release(opened.data) : <SharedAnswerView snapshot={opened.data} />;
}
