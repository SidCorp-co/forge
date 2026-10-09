"use client";

// A clip or picture on a release page (BC-3). In the app the file is an issue attachment behind the
// session, so its bytes are fetched with the session's credentials and played from a local object
// URL (the pattern of `features/workflows/canvas/wireframe-thumb.tsx`); on a share link the file is a
// short-lived download ticket that carries its own right to be read, so it plays from its address.

import type { ReleaseMediaRef } from "@forge/contracts/release-page";
import { Skeleton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useMediaSrc } from "@/lib/utils/use-media-src";

export function ReleaseMedia({ media, label, authed }: { media: ReleaseMediaRef; label: string; authed: boolean }) {
  const t = useCopy();
  const src = useMediaSrc(media.url, authed);
  if (src.state === "loading") return <Skeleton className="aspect-video w-full max-w-xl" />;
  if (src.state === "lost")
    return (
      <p className="text-12-5 text-muted" data-testid="release-media-lost">
        {t("releases.page.highlights.mediaLost")}
      </p>
    );
  return media.kind === "clip" ? (
    // biome-ignore lint/a11y/useMediaCaption: a QA screen recording has no spoken track to caption
    <video className="aspect-video w-full max-w-xl rounded-md border border-line bg-sunken" src={src.src} controls preload="metadata" playsInline aria-label={label} data-testid="release-media-clip" />
  ) : (
    // biome-ignore lint/performance/noImgElement: a blob or ticket address, which next/image cannot optimise
    <img className="max-h-96 w-auto max-w-full rounded-md border border-line" src={src.src} alt={label} data-testid="release-media-picture" />
  );
}
