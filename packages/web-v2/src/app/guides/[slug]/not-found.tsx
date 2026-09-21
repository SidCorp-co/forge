import { headers } from "next/headers";
import Link from "next/link";
import { PageTitle } from "@/design";
import { LINK_CLASS } from "@/design/patterns/body-tags";
import {
  INDEX_HREF,
  MISSING_GUIDE_BODY,
  MISSING_GUIDE_LINK_TEXT,
  missingGuideHeading,
} from "@/features/guides/missing";
import { GUIDE_PATH_HEADER, slugFromGuidePath } from "@/features/guides/requested-path";

/** The 404 a client-side navigation lands on; a plain request is answered by the
 *  middleware — docs/modules/guides/public-pages.md. */
export default async function GuideNotFound() {
  const slug = slugFromGuidePath((await headers()).get(GUIDE_PATH_HEADER));
  return (
    <div className="mx-auto flex min-h-dvh max-w-[72ch] flex-col justify-center gap-4 bg-app px-6 py-12">
      <PageTitle className="fg-h2 text-fg">{missingGuideHeading(slug)}</PageTitle>
      <p className="fg-body-sm text-muted">{MISSING_GUIDE_BODY}</p>
      <p>
        <Link href={INDEX_HREF} className={LINK_CLASS}>
          {MISSING_GUIDE_LINK_TEXT}
        </Link>
      </p>
    </div>
  );
}
