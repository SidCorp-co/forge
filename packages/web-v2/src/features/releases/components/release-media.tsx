"use client";

// A clip or picture on a release page (BC-3). In the app the file is an issue attachment behind the
// session, so its bytes are fetched with the session's credentials and played from a local object
// URL (the pattern of `features/workflows/canvas/wireframe-thumb.tsx`); on a share link the file is a
// short-lived download ticket that carries its own right to be read, so it plays from its address.

import type { ReleaseMediaRef } from "@forge/contracts/release-page";
import { useEffect, useState } from "react";
import { Skeleton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { coreFileUrl } from "@/lib/utils/core-url";

type Src = { state: "loading" } | { state: "ready"; src: string } | { state: "lost" };

/** The address a media file plays from, or why it cannot. */
export function useMediaSrc(url: string | undefined, authed: boolean): Src {
  const [got, setGot] = useState<{ url: string; src: Src } | null>(null);
  useEffect(() => {
    if (!url || !authed) return;
    const ctl = new AbortController();
    let made: string | null = null;
    fetch(coreFileUrl(url), { credentials: "include", signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        made = URL.createObjectURL(blob);
        setGot({ url, src: { state: "ready", src: made } });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setGot({ url, src: { state: "lost" } });
      });
    return () => {
      ctl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, authed]);
  if (!url) return { state: "lost" };
  if (!authed) return { state: "ready", src: coreFileUrl(url) };
  return got?.url === url ? got.src : { state: "loading" };
}

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
