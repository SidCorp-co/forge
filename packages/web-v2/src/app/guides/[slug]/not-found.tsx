import { headers } from "next/headers";
import Link from "next/link";
import { LINK_CLASS } from "@/design/patterns/body-tags";
import { GUIDE_PATH_HEADER, slugFromGuidePath } from "@/features/guides/requested-path";

/** The 404 for an address under `/guides` that names no guide. It says which
 *  slug was asked for and where the index is, rather than redirecting to the
 *  index — a redirect turns a broken link into a working one and hides it.
 *
 *  What this page reaches, measured on the standalone server (ISS-1124): the
 *  response status is 404, and this body is delivered as flight data rather than
 *  as HTML, because `notFound()` raised in a dynamic route makes Next emit its
 *  bare error document and discard the page's own head as well. A browser
 *  renders this; a reader without JavaScript gets the status and an empty body.
 *  The named refusal a machine reader needs is on the API beside it, in plain
 *  text: `GET /api/guides/<slug>.md` answers 404 naming every valid slug and
 *  the address of these pages. Closing the gap here would mean answering the
 *  request from middleware — the only layer that can set a status and a body
 *  together — at the cost of a core round-trip on every guide view and a second
 *  copy of this message; that is the trade this leaves open, and what ends it is
 *  Next server-rendering a `notFound()` body. */
export default async function GuideNotFound() {
  const slug = slugFromGuidePath((await headers()).get(GUIDE_PATH_HEADER));
  return (
    <div className="mx-auto flex min-h-dvh max-w-[72ch] flex-col justify-center gap-4 bg-app px-6 py-12">
      <h1 className="fg-h2 text-fg">
        {slug ? `Forge publishes no guide called “${slug}”` : "Forge publishes no guide at that address"}
      </h1>
      <p className="fg-body-sm text-muted">
        The index lists every guide there is, and each one is also readable as markdown at{" "}
        <code className="font-mono">/api/guides/&lt;slug&gt;.md</code> with no credential.
      </p>
      <p>
        <Link href="/guides" className={LINK_CLASS}>
          All Forge guides
        </Link>
      </p>
    </div>
  );
}
