// What a feedback item says, in its peek: the reporter's text, held to a few lines with the rest a
// click away in place, and its evidence as thumbnails — screenshots open the lightbox, recordings are
// counted and played on the full page. Each is left out where the item has none. The step it hits is
// the About facts' line below, so it is not drawn twice.

import { useState } from "react";
import { FactsGroup, PeekExcerpt } from "@/design";
import { ImageLightbox, type LightboxImage } from "@/features/attachments";
import { useCopy } from "@/lib/i18n/interface-language";
import { WrittenMark } from "@/lib/i18n/written";
import { coreFileUrl } from "@/lib/utils/core-url";
import { useItemRecordings } from "../hooks";
import type { FeedbackView } from "../types";
import { uploadedRecordings } from "./recordings";

/** Thumbnails a peek shows before the rest are counted on the last tile. */
const SHOWN = 4;

export function FeedbackPeekSaid({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const recordings = useItemRecordings(projectId, f.key);
  const body = f.body?.trim() ? f.body : null;
  const shots = f.attachments.filter((a) => a.mime.startsWith("image/"));
  const played = uploadedRecordings(f).length + (recordings.data?.length ?? 0);
  const said = f.redacted || body !== null;
  if (!said && shots.length === 0 && played === 0) return null;
  // a hairline under these and over the facts, whose first group draws none of its own
  return (
    <div className="mb-3.5 border-b border-line-subtle" data-testid="feedback-peek-said">
      {said ? (
        <FactsGroup title={t("feedback.body.heading")} testId="feedback-peek-body">
          {f.redacted ? (
            <p className="text-13 text-subtle">{t("feedback.body.redacted")}</p>
          ) : (
            <PeekExcerpt>
              <p className="whitespace-pre-wrap leading-relaxed" lang={f.writtenLang ?? undefined}>
                {body}
                <WrittenMark lang={f.writtenLang} />
              </p>
            </PeekExcerpt>
          )}
        </FactsGroup>
      ) : null}
      {shots.length > 0 || played > 0 ? (
        <FactsGroup title={t("feedback.evidence.title")} testId="feedback-peek-evidence">
          {shots.length > 0 ? (
            <Thumbnails
              images={shots.map((a, i) => ({
                id: a.id,
                name: a.name,
                href: coreFileUrl(a.url),
                alt: t("feedback.evidence.shotAlt", { n: i + 1, of: shots.length, key: f.key, title: f.title }),
              }))}
            />
          ) : null}
          {played > 0 ? (
            <p className="mt-2 text-13 text-muted" data-testid="feedback-peek-recordings">
              {played === 1 ? t("feedback.peek.recordingOne") : t("feedback.peek.recordings", { n: played })}
            </p>
          ) : null}
        </FactsGroup>
      ) : null}
    </div>
  );
}

/** The first few screenshots as tiles, the last one counting the rest; any opens the lightbox on itself. */
function Thumbnails({ images }: { images: LightboxImage[] }) {
  const t = useCopy();
  const [open, setOpen] = useState<number | null>(null);
  const more = images.length - SHOWN;
  const frame = "relative block overflow-hidden rounded-md border border-line transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:shadow-focus";
  return (
    <>
      <ul className="flex flex-wrap gap-2" data-testid="feedback-peek-shots">
        {images.slice(0, SHOWN).map((img, i) => {
          const counts = i === SHOWN - 1 && more > 0;
          return (
            <li key={img.id}>
              <button type="button" onClick={() => setOpen(i)} className={frame} aria-label={counts ? t("feedback.peek.moreShots", { alt: img.alt ?? img.name, n: more }) : img.alt}>
                <img src={img.href} alt="" width={72} height={72} className="size-18 object-cover" />
                {counts ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-fg/55 text-14 font-semibold text-surface" data-testid="feedback-peek-more">
                    +{more}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {open !== null && images[open] ? <ImageLightbox images={images} index={open} onClose={() => setOpen(null)} onIndexChange={setOpen} /> : null}
    </>
  );
}
