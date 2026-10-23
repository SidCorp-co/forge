// A clip or picture on a release page (BC-3). In the app the file is an issue attachment behind the
// session, so its bytes are fetched with the session's credentials and played from a local object
// URL (the pattern of `features/workflows/canvas/wireframe-thumb.tsx`); on a share link the file is a
// short-lived download ticket that carries its own right to be read, so it plays from its address.
// A clip plays inline and muted, with its controls, opening on the still QA kept beside it; where it
// kept none, on its own first frame.

import { captionsOf } from "@/lib/utils/captions";
import type { ReleaseMediaRef } from "@forge/contracts/release-page";
import { Skeleton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useMediaSrc } from "@/lib/utils/use-media-src";

/** The frame a clip with no kept still opens on: a moment in, so the first frame is drawn. */
const FIRST_FRAME = "#t=0.1";

export function ReleaseMedia({ media, label, authed }: { media: ReleaseMediaRef; label: string; authed: boolean }) {
  const t = useCopy();
  const src = useMediaSrc(media.url, authed);
  const still = useMediaSrc(media.poster?.url, authed);
  if (src.state === "loading") return <Skeleton className="aspect-video w-full max-w-xl" />;
  if (src.state === "lost")
    return (
      <p className="text-13 text-muted" data-testid="release-media-lost">
        {t("releases.page.highlights.mediaLost")}
      </p>
    );
  if (media.kind === "picture")
    return <img className="h-auto max-h-96 w-auto max-w-full rounded-md border border-line" src={src.src} alt={label} data-testid="release-media-picture" />;
  const poster = still.state === "ready" ? still.src : undefined;
  return (
    // a QA screen recording has no spoken words: its captions are its text alternative
    <video
      className="h-auto max-h-96 w-full max-w-xl rounded-md border border-line bg-sunken object-contain"
      src={poster ? src.src : `${src.src}${FIRST_FRAME}`}
      poster={poster}
      controls
      muted
      playsInline
      preload="metadata"
      aria-label={label}
      data-testid="release-media-clip"
      data-poster={poster ? "kept" : "first-frame"}
    >
      <track kind="captions" src={captionsOf(label)} label={label} default />
    </video>
  );
}
