import Link from "next/link";
import { headers } from "next/headers";
import { LINK_CLASS } from "@/design/patterns/body-tags";
import {
  INDEX_HREF,
  MISSING_GUIDE_BODY,
  MISSING_GUIDE_LINK_TEXT,
  missingGuideHeading,
} from "@/features/guides/missing";
import { GUIDE_PATH_HEADER, slugFromGuidePath } from "@/features/guides/requested-path";

/** The 404 a client-side navigation to an unknown guide lands on. A plain
 *  request never reaches here — the middleware answers it with the same words as
 *  an HTML document, for the reasons `features/guides/missing.ts` records. It
 *  says which slug was asked for and where the index is, rather than redirecting
 *  to the index, which turns a broken link into a working one and hides it. */
export default async function GuideNotFound() {
  const slug = slugFromGuidePath((await headers()).get(GUIDE_PATH_HEADER));
  return (
    <div className="mx-auto flex min-h-dvh max-w-[72ch] flex-col justify-center gap-4 bg-app px-6 py-12">
      <h1 className="fg-h2 text-fg">{missingGuideHeading(slug)}</h1>
      <p className="fg-body-sm text-muted">{MISSING_GUIDE_BODY}</p>
      <p>
        <Link href={INDEX_HREF} className={LINK_CLASS}>
          {MISSING_GUIDE_LINK_TEXT}
        </Link>
      </p>
    </div>
  );
}
