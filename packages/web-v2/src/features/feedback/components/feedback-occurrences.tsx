// The reports that joined an item after its filing (REQ-66 BC-3): who said it again, when, from where,
// in their own words, with the screenshot they took. A repeat is a row here, never an item of its own.

import { ActorChip } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { FeedbackView } from "../types";

export function FeedbackOccurrences({ f }: { f: FeedbackView }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (f.occurrences.length === 0) return null;
  const urlOf = (id: string | null) => (id ? f.attachments.find((a) => a.id === id)?.url : undefined);
  return (
    <section className="mt-6" data-testid="feedback-occurrences">
      <h3 className="mb-2 text-13 font-semibold text-fg">{t("feedback.occurrences.heading", { n: f.occurrences.length })}</h3>
      <ul className="border-t border-line-subtle">
        {f.occurrences.map((o) => {
          const shot = urlOf(o.attachmentId);
          return (
            <li key={o.id} className="grid gap-1 border-b border-line-subtle py-2.5 text-13" data-testid="feedback-occurrence">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <ActorChip name={o.reporter.name ?? t("feedback.unknownReporter")} kind={o.reporter.agency} />
                <span className="text-muted" title={time.dateTime(o.at)}>
                  {time.relative(o.at)}
                </span>
                {o.from ? <span className="text-muted">{t("feedback.occurrences.from", { project: o.from.name })}</span> : null}
                {shot ? (
                  <a href={shot} target="_blank" rel="noreferrer" className="text-link hover:underline" data-testid="feedback-occurrence-shot">
                    {t("feedback.occurrences.screenshot")}
                  </a>
                ) : null}
              </span>
              {o.said ? <span className="whitespace-pre-wrap text-fg">{o.said}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
