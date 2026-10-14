import { headers } from "next/headers";
import Link from "next/link";
import { PageTitle } from "@/design";
import { LINK_CLASS } from "@/design/patterns/body-tags";
import { GuideShell } from "@/features/guides/components/guide-shell";
import { INDEX_PATH } from "@/features/guides/audience";
import { ALL_DOORS_LINK_TEXT, MISSING_GUIDE_BODY, missingGuideHeading } from "@/features/guides/missing";
import { GUIDE_PATH_HEADER, slugFromGuidePath } from "@/features/guides/requested-path";

/** The 404 a client-side navigation lands on, inside the docs' own chrome; a plain request is
 *  answered by the middleware — docs/modules/guides/public-pages.md. */
export default async function GuideNotFound() {
  const slug = slugFromGuidePath((await headers()).get(GUIDE_PATH_HEADER));
  return (
    <GuideShell>
      <div className="mx-auto flex max-w-[72ch] flex-col gap-4 py-8">
        <PageTitle className="fg-h2 text-fg">{missingGuideHeading(slug)}</PageTitle>
        <p className="fg-body-sm text-muted">{MISSING_GUIDE_BODY}</p>
        <p>
          <Link href={INDEX_PATH} className={LINK_CLASS}>
            {ALL_DOORS_LINK_TEXT}
          </Link>
        </p>
      </div>
    </GuideShell>
  );
}
