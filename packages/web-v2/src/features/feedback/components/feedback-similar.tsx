// Similar feedback: the filed items nearest one item, by the vectors core stores for each (`GET
// …/feedback/:fb/similar`), and the likely duplicates of a draft before it is sent (`POST
// …/feedback/similar`), so a person finds the item already filed instead of filing it twice. A read
// core could not compare says why in its own words, never as an empty list that would read as
// "nothing similar".

import type { SimilarFeedbackResponse } from "@forge/contracts/feedback";
import { Link } from "@/lib/navigation/router";
import { StatusBadge, useDebounced } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { feedbackHref } from "@/lib/routes/feedback";
import { useDraftDuplicates, useSimilarFeedback } from "../hooks";

/** Words a draft's title needs before it is compared: fewer match everything a little. */
const DRAFT_WORDS = 3;
/** The pause after typing before a draft is compared. */
const DRAFT_PAUSE_MS = 700;
/** The likely duplicates a draft shows. */
const DRAFT_HITS = 3;

const NOT_COMPARED: Record<Exclude<SimilarFeedbackResponse["status"], "ok">, ProductCopyKey> = {
  not_embedded: "feedback.similar.status.notEmbedded",
  provider_not_configured: "feedback.similar.status.unconfigured",
  failed: "feedback.similar.status.providerFailed",
  withheld_by_policy: "feedback.similar.status.withheld",
};

function Hits({ read, slug, limit }: { read: SimilarFeedbackResponse; slug: string; limit?: number }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (read.status !== "ok") {
    return (
      <p className="text-13 text-muted" data-testid="similar-not-compared" data-status={read.status} title={read.message}>
        {t(NOT_COMPARED[read.status])}
      </p>
    );
  }
  const hits = read.hits.slice(0, limit ?? read.hits.length);
  if (hits.length === 0) {
    return (
      <p className="text-13 text-subtle" data-testid="similar-none">
        {t("feedback.similar.none")}
      </p>
    );
  }
  return (
    <ul className="grid gap-1.5" data-testid="similar-hits">
      {hits.map((h) => (
        <li key={h.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-13" data-testid="similar-hit" data-key={h.key}>
          <Link href={feedbackHref(slug, h.key)} className="font-mono text-12 font-semibold text-link hover:underline">
            {h.key}
          </Link>
          <span className="min-w-0 flex-1 truncate">{h.title}</span>
          <StatusBadge family="feedbackPhase" value={h.phase} />
          <span className="tabular-nums text-12 text-muted">{t("feedback.similar.alike", { pct: time.number(Math.round(Math.max(0, h.similarity) * 100)) })}</span>
        </li>
      ))}
    </ul>
  );
}

/** The filed items nearest this one, on its page. */
export function SimilarFeedback({ projectId, slug, fbKey }: { projectId: string; slug: string; fbKey: string }) {
  const t = useCopy();
  const q = useSimilarFeedback(projectId, fbKey);
  return (
    <section aria-label={t("feedback.similar.title")} data-testid="feedback-similar">
      <h2 className="mb-3 text-14 font-semibold leading-snug text-fg">{t("feedback.similar.title")}</h2>
      {q.data ? (
        <Hits read={q.data} slug={slug} />
      ) : q.isError ? (
        <p className="text-13 text-danger" role="alert">
          {t("feedback.similar.unread")}
        </p>
      ) : (
        <p className="text-13 text-subtle">{t("feedback.similar.checking")}</p>
      )}
    </section>
  );
}

/** Likely duplicates of what is being typed, compared once the title says enough and the typing pauses. */
export function DraftDuplicates({ projectId, slug, title, body }: { projectId: string; slug: string; title: string; body: string }) {
  const t = useCopy();
  const settledTitle = useDebounced(title.trim(), DRAFT_PAUSE_MS);
  const settledBody = useDebounced(body.trim(), DRAFT_PAUSE_MS);
  const enough = settledTitle.split(/\s+/).filter(Boolean).length >= DRAFT_WORDS;
  const q = useDraftDuplicates(projectId, enough ? { title: settledTitle, ...(settledBody ? { body: settledBody } : {}) } : null);
  if (!enough) return null;
  return (
    <section aria-label={t("feedback.similar.draftTitle")} className="grid gap-1.5 rounded-md border border-line-subtle bg-sunken px-3 py-2.5" data-testid="feedback-draft-duplicates">
      <p className="text-12 font-semibold text-muted">{t("feedback.similar.draftTitle")}</p>
      {q.data ? (
        <Hits read={q.data} slug={slug} limit={DRAFT_HITS} />
      ) : q.isError ? (
        <p className="text-13 text-danger" role="alert">
          {t("feedback.similar.unread")}
        </p>
      ) : (
        <p className="text-13 text-subtle">{t("feedback.similar.checking")}</p>
      )}
    </section>
  );
}
