import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

/**
 * The page a `ref` cell opens: ISS-n is an issue, REQ-n a requirement, FB-n a feedback item, and
 * every other ref is a release version. A ref is an entity key by the frame's own contract, so a
 * release is the one kind with no prefix to read.
 */
export function refHref(slug: string, ref: string): string {
  if (/^ISS-\d+$/.test(ref)) return issueHref(slug, ref);
  if (/^REQ-\d+$/.test(ref)) return requirementHref(slug, ref);
  if (/^FB-\d+$/.test(ref)) return feedbackHref(slug, ref);
  return releaseHref(slug, ref);
}
