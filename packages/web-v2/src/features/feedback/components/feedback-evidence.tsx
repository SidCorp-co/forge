"use client";

// What a feedback item opens on (REQ-35 BC-8, BC-12; Feedback lifecycle step `evidence`): its
// screenshots, its recordings and the workflow step it hits, above its text and actions. Each is
// shown only where the item has it; none is required, and an item with none opens on its text. A
// screenshot is read by its place and the item it belongs to, never by its file name.

import { useState } from "react";
import { ImageLightbox, type LightboxImage } from "@/features/attachments/components/image-lightbox";
import { useCopy } from "@/lib/i18n/interface-language";
import { coreFileUrl } from "@/lib/utils/core-url";
import { useItemRecordings } from "../hooks";
import type { FeedbackView } from "../types";
import { FeedbackStep } from "./feedback-step";
import { Recordings, uploadedRecordings } from "./recordings";

/** An attachment the evidence draws in place of listing it as a file: a screenshot or a recording. */
export const isEvidenceMedia = (mime: string) => mime.startsWith("image/") || mime.startsWith("video/");

export function FeedbackEvidence({ projectId, slug, f }: { projectId: string; slug: string; f: FeedbackView }) {
  const t = useCopy();
  const recordings = useItemRecordings(projectId, f.key);
  const shots = f.attachments.filter((a) => a.mime.startsWith("image/"));
  const hasRecordings = uploadedRecordings(f).length > 0 || (recordings.data?.length ?? 0) > 0 || recordings.isError;
  const node = f.target.type === "workflow" ? f.target.node : undefined;
  if (shots.length === 0 && !hasRecordings && !node) return null;
  return (
    <section aria-label={t("feedback.evidence.title")} data-testid="feedback-evidence" data-highlight="evidence" className="grid min-w-0 gap-6">
      {shots.length > 0 ? (
        <Screenshots
          images={shots.map((a, i) => ({
            id: a.id,
            name: a.name,
            href: coreFileUrl(a.url),
            alt: t("feedback.evidence.shotAlt", { n: i + 1, of: shots.length, key: f.key, title: f.title }),
          }))}
        />
      ) : null}
      {hasRecordings ? <Recordings projectId={projectId} f={f} /> : null}
      {node ? <FeedbackStep projectId={projectId} slug={slug} flow={f.target.key} title={f.target.title} node={node} /> : null}
    </section>
  );
}

/** The first screenshot at reading size, the rest as thumbnails; any opens the lightbox on itself. */
function Screenshots({ images }: { images: LightboxImage[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [lead, ...rest] = images;
  if (!lead) return null;
  const frame = "block overflow-hidden rounded-md border border-line transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";
  return (
    <div className="grid min-w-0 gap-2" data-testid="feedback-screenshots">
      <button type="button" onClick={() => setOpen(0)} className={`${frame} w-fit max-w-full`}>
        {/* biome-ignore lint/performance/noImgElement: an attachment served from the API by an authenticated URL the Next image optimizer cannot fetch */}
        <img src={lead.href} alt={lead.alt} className="block max-h-[360px] max-w-full object-contain max-md:max-h-[260px]" />
      </button>
      {rest.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {rest.map((img, i) => (
            <li key={img.id}>
              <button type="button" onClick={() => setOpen(i + 1)} className={frame}>
                {/* biome-ignore lint/performance/noImgElement: an attachment served from the API by an authenticated URL the Next image optimizer cannot fetch */}
                <img src={img.href} alt={img.alt} className="size-20 object-cover" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open !== null && images[open] ? <ImageLightbox images={images} index={open} onClose={() => setOpen(null)} onIndexChange={setOpen} /> : null}
    </div>
  );
}
