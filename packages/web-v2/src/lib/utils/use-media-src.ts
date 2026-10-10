
// A file behind the session, played from where a person can reach it: fetched with the session's
// credentials into a local object URL (the pattern of `features/workflows/canvas/wireframe-thumb.tsx`),
// or, where the address carries its own right to be read (a share's download ticket), from itself.

import { useEffect, useState } from "react";
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
