"use client";

import { createContext, type ImgHTMLAttributes, useContext, useEffect, useState } from "react";
import { useRetryWait, useWaitAnnounced } from "@/design/hooks/use-retry-wait";
import { RetryWait } from "@/design/primitives/retry-wait";
import { cn } from "@/lib/utils/cn";
import { fileWaitWords, shownAgainWords } from "@/lib/utils/retry-rule";

/** How the kit reads a file on the core, handed in by the app: the kit holds no API client. */
export interface CoreFiles {
  /** The file as an address this page can show, or what its read failed with; asks nothing until `enabled`. */
  useFile(path: string, enabled: boolean): { src: string | null; error: unknown };
}

const CoreFilesContext = createContext<CoreFiles | null>(null);
export const CoreFilesProvider = CoreFilesContext.Provider;

/** How far outside the screen an image starts loading, so it is there by the time it is scrolled to. */
const LOADS_WITHIN = "200px";

/** Whether the element has come near the screen; at once where the browser cannot tell. The element is followed as
 *  it changes, so a failure shown from the cache is watched too and asked again once its wait ends. */
function useNearScreen<T extends Element>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: LOADS_WITHIN });
    seen.observe(el);
    return () => seen.disconnect();
  }, [el, near]);
  return [setEl, near];
}

/**
 * An image that is a file on the core (`/api/…`), read through the API client rather than by the browser from its
 * address, so a refusal with a wait holds it like any read and it comes back by itself once the wait ends (ISS-1229
 * r55, judge-170). Until it is near the screen it asks for nothing, as `loading="lazy"` did.
 */
export function CoreImage({
  path,
  alt,
  className,
  ...img
}: { path: string; alt: string; className?: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "className">) {
  const files = useContext(CoreFilesContext);
  if (!files) throw new Error(`CoreImage drew ${path} outside a CoreFilesProvider, so nothing can read it through the client`);
  const [ref, near] = useNearScreen<HTMLSpanElement>();
  const file = files.useFile(path, near);
  const wait = useRetryWait(file.error, shownAgainWords);
  useWaitAnnounced(file.error, fileWaitWords(file.error, alt || "the image"));
  if (file.src) {
    // biome-ignore lint/performance/noImgElement: the bytes are already in memory as an object URL, which `next/image` cannot take
    return <img src={file.src} alt={alt} className={className} {...img} />;
  }
  if (file.error) {
    return (
      <span ref={ref} data-testid="core-image-failed" className={cn("inline-flex flex-col items-center justify-center gap-1 bg-surface p-2 text-center", className)}>
        <span className="fg-caption break-all text-muted">{alt ? `${alt} not loaded.` : "Image not loaded."}</span>
        {wait && <RetryWait wait={wait} testId="core-image" />}
      </span>
    );
  }
  return <span ref={ref} role="img" aria-label={alt} aria-busy="true" className={cn("inline-block bg-surface", className)} />;
}
