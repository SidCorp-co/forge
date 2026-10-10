
// A clip or picture on a release page (BC-3). In the app the file is an issue attachment behind the
// session, so its bytes are fetched with the session's credentials and played from a local object
// URL (the pattern of `features/workflows/canvas/wireframe-thumb.tsx`); on a share link the file is a
// short-lived download ticket that carries its own right to be read, so it plays from its address.

import { captionsOf } from "@/lib/utils/captions";
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
      <p className="text-13 text-muted" data-testid="release-media-lost">
        {t("releases.page.highlights.mediaLost")}
      </p>
    );
  return media.kind === "clip" ? (
    // a QA screen recording has no spoken words: its captions are its text alternative
    <video className="aspect-video w-full max-w-xl rounded-md border border-line bg-sunken" src={src.src} controls preload="metadata" playsInline aria-label={label} data-testid="release-media-clip">
      <track kind="captions" src={captionsOf(label)} label={label} default />
    </video>
  ) : (
    // unoptimized: a blob or ticket address, which the Next image optimizer cannot fetch
    <img className="h-auto max-h-96 w-auto max-w-full rounded-md border border-line" src={src.src} alt={label} width={0} height={0} sizes="100vw" data-testid="release-media-picture" />
  );
}
