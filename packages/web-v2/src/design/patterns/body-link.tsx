"use client";

// The one rendering of `classifyBodyHref`, shared by the two body renderers.
// `markdown.tsx` draws a markdown body and `body-view.tsx` draws a parsed
// `format: html` one, and a body is written once and read both ways — so the
// five branches live here rather than once per renderer. The fork this shape
// exists to prevent is the one `markdown.tsx`'s own `cm:guard` records.

import Link from "next/link";
import type { ReactNode } from "react";
import { addressesAFile, type BodyHref, classifyBodyHref } from "@/lib/utils/body-href";
import { COMPACT_TAG_CLASS, LINK_CLASS } from "./body-tags";

/** An href that names neither origin is shown as refused, in words on the page
 *  rather than in a `title` a hover reveals: a keyboard, touch or screen-reader
 *  reader gets the same answer as a mouse one. */
function Refused({ noun, target, reason, children }: {
  noun: string;
  target: string;
  reason: string;
  children: ReactNode;
}) {
  return (
    <span className="text-muted">
      {children}
      <span className="fg-caption ml-1 rounded-sm border border-line-subtle bg-sunken px-1 py-0.5 text-muted">
        {noun} not shown: {target || "(empty)"} — {reason}
      </span>
    </span>
  );
}

/** Why a classification does not name an image. */
function imageRefusal(target: BodyHref): string {
  if (target.kind === "anchor") return "this names a place on the page, not an image";
  if (target.kind === "external") return `${target.scheme} names a person, not an image`;
  return target.kind === "unresolvable" ? target.reason : "";
}

/** A link in a body, drawn against the origin its href belongs to: an app route
 *  in the same tab, a core file or an external URL in a new one. */
export function BodyLink({ href, children }: { href?: string; children: ReactNode }): ReactNode {
  const target: BodyHref = classifyBodyHref(href ?? "");
  if (target.kind === "in-app") {
    return (
      <Link href={target.href} className={LINK_CLASS}>
        {children}
      </Link>
    );
  }
  if (target.kind === "anchor") {
    return (
      <a href={target.href} className={LINK_CLASS}>
        {children}
      </a>
    );
  }
  if (target.kind === "unresolvable") {
    return (
      <Refused noun="link" target={target.href} reason={target.reason}>
        {children}
      </Refused>
    );
  }
  return (
    <a href={target.href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/** An image in a body. Every classification that addresses a file draws an
 *  `<img>` from it; everything else draws the refusal, from the alt text. */
export function BodyImage({ src, alt }: { src?: string; alt?: string }): ReactNode {
  const target: BodyHref = classifyBodyHref(src ?? "");
  if (!addressesAFile(target)) {
    return (
      <Refused noun="image" target={src ?? ""} reason={imageRefusal(target)}>
        {alt || "image"}
      </Refused>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: a body image is an arbitrary attachment or external URL with no known intrinsic size, and `next/image` needs both a configured remote host and dimensions — the reason `body-view.tsx` carried this same comment before both renderers came here
    <img src={target.href} alt={alt ?? ""} className={COMPACT_TAG_CLASS.img} />
  );
}
