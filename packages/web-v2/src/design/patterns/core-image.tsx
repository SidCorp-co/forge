"use client";

import { type ImgHTMLAttributes, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRetryWait, useRetryWaiting } from "@/design/hooks/use-retry-wait";
import { RetryWait } from "@/design/primitives/retry-wait";
import { coreFileQuery, useCoreFile } from "@/lib/api/core-file";
import { cn } from "@/lib/utils/cn";
import { shownAgainWords } from "@/lib/utils/retry-rule";

/** How far outside the screen an image starts loading, so it is there by the time it is scrolled to. */
const LOADS_WITHIN = "200px";

/** Whether the element has come near the screen; at once where the browser cannot tell. */
function useNearScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
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
  }, [near]);
  return [ref, near];
}

/**
 * An image that is a file on the core (`/api/…`), loaded through the API client rather than by the browser from its
 * address, so a refusal with a wait holds it like any read and it comes back by itself once the wait ends (ISS-1229
 * r55, judge-170). Until it is near the screen it asks for nothing, as `loading="lazy"` did.
 */
export function CoreImage({
  path,
  alt,
  className,
  ...img
}: { path: string; alt: string; className?: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "className">) {
  const [ref, near] = useNearScreen<HTMLSpanElement>();
  const file = useCoreFile(path, near);
  const wait = useRetryWait(file.error, shownAgainWords);
  if (file.src) {
    // biome-ignore lint/performance/noImgElement: the bytes are already in memory as an object URL, which `next/image` cannot take
    return <img src={file.src} alt={alt} className={className} {...img} />;
  }
  if (file.error) {
    return (
      <span data-testid="core-image-failed" className={cn("inline-flex flex-col items-center justify-center gap-1 bg-surface p-2 text-center", className)}>
        <span className="fg-caption break-all text-muted">{alt ? `${alt} not loaded.` : "Image not loaded."}</span>
        {wait && <RetryWait wait={wait} testId="core-image" />}
      </span>
    );
  }
  return <span ref={ref} role="img" aria-label={alt} aria-busy="true" className={cn("inline-block bg-surface", className)} />;
}

/** Whether a core file's read is held on a refusal whose wait still runs; it reads what is known and asks nothing. */
export function useCoreFileHeld(path: string): boolean {
  const q = useQuery({ ...coreFileQuery(path), enabled: false });
  return useRetryWaiting(q.isError ? q.error : null);
}
