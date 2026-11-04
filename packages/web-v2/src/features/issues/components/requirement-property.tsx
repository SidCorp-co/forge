// The issue rail's Requirement property: the requirement the issue delivers, read by its title and
// linked to its page, its key on hover (REQ-11 BC-19). Linking and unlinking an issue is the
// project's agents' act, never a person's (REQ-68 BC-6, ISS-687): core refuses it from the web by
// name (`REQUIREMENT_ISSUE_ACT_FORBIDDEN`), so the rail offers no picker and no Unlink. A sibling
// project's requirement is named with its project and links there.

import { Link } from "@/lib/navigation/router";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { cn } from "@/lib/utils/cn";
import type { OtherProject } from "@forge/contracts/requirements";

export function IssueRequirementProperty({
  slug,
  current,
  currentTitle = null,
  requirementProject = null,
}: {
  slug: string;
  /** The requirement it delivers, by key; null while it delivers none. */
  current: string | null;
  /** That requirement's title, the link's face; its key is the tooltip (REQ-11 BC-19). */
  currentTitle?: string | null;
  /** The requirement's project, where it is a sibling project's rather than the issue's own. */
  requirementProject?: OtherProject | null;
}) {
  const t = useCopy();
  if (!current) return <span className="fg-body-sm text-subtle">{t("issues.rail.requirementNone")}</span>;
  const named = requirementProject ? `${requirementProject.slug}/${current}` : current;
  return (
    <Link
      href={requirementHref(requirementProject?.slug ?? slug, current)}
      className={cn("min-w-0 truncate text-12 font-semibold text-link hover:underline", !currentTitle && "font-mono")}
      title={named}
      data-testid="issue-requirement"
    >
      {currentTitle || named}
    </Link>
  );
}
