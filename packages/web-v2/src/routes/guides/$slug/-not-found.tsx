import { PageTitle } from "@/design";
import { LINK_CLASS } from "@/design/patterns/body-tags";
import {
  INDEX_HREF,
  MISSING_GUIDE_BODY,
  MISSING_GUIDE_LINK_TEXT,
  missingGuideHeading,
} from "@/features/guides/missing";
import { Link, useParams } from "@/lib/navigation/router";

/** The 404 a navigation inside the web lands on; core answers a plain request for the same
 *  address with its own 404 document (docs/modules/guides/public-pages.md). */
export function GuideNotFound() {
  const { slug = "" } = useParams<{ slug?: string }>();
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
