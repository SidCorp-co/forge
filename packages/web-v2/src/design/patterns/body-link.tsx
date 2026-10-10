

import { Link } from "@/lib/navigation/router";
import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { addressesAFile, type BodyHref, classifyBodyHref } from "@/lib/utils/body-href";
import { COMPACT_TAG_CLASS, LINK_CLASS } from "./body-tags";

/** An href that names neither origin is shown as refused, in words on the page
 *  rather than in a `title` a hover reveals: a keyboard, touch or screen-reader
 *  reader gets the same answer as a mouse one. */
function Refused({ noun, target, reason, children }: {
  noun: "link" | "image";
  target: string;
  reason: string;
  children: ReactNode;
}) {
  const t = useCopy();
  return (
    <span className="text-muted">
      {children}
      <span className="fg-caption ml-1 rounded-sm border border-line-subtle bg-sunken px-1 py-0.5 text-muted">
        {t("common.body.notShown", { noun: t(`common.body.${noun}`), target: target || t("common.body.targetEmpty"), reason })}
      </span>
    </span>
  );
}

/** Why a classification does not name an image. */
function imageRefusal(target: BodyHref, t: Copy): string {
  if (target.kind === "anchor") return t("common.body.anchorNotImage");
  if (target.kind === "external") return t("common.body.schemeNotImage", { scheme: target.scheme });
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
  const t = useCopy();
  const target: BodyHref = classifyBodyHref(src ?? "");
  if (!addressesAFile(target)) {
    return (
      <Refused noun="image" target={src ?? ""} reason={imageRefusal(target, t)}>
        {alt || t("common.body.image")}
      </Refused>
    );
  }
  return (
    // an attachment or external URL of no known size: drawn at its own
    <img src={target.href} alt={alt ?? ""} className={COMPACT_TAG_CLASS.img} />
  );
}
