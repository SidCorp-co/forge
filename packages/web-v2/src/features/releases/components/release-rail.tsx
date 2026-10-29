// The release page's rail (REQ-40 BC-5, BC-19): where the release stands in plain words, the
// requirements it delivers with how many of their criteria it proves, and the page's contents. The
// criteria themselves are the Technical view's; the rail counts them and never lists them.

import type { ReleasePage, ReleasePageRequirement } from "@forge/contracts/release-page";
import { type ContentsItem, ContentsList, CoverageBar, Fact, FactsGroup } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { requirementHref } from "@/lib/routes/requirements";
import { releaseStandingOf } from "../release-standing";
import type { ReleaseDetail } from "../types";

/**
 * A requirement's criteria this release proves, said once on the page and drawn as a bar out of its
 * own total (REQ-35 BC-9), counted by the rule the requirement counts by (REQ-35). A requirement with
 * no criteria of its own says how many issue checks trace to it instead.
 */
function RequirementCount({ r }: { r: ReleasePageRequirement }) {
  const t = useCopy();
  if (!r.business || r.business.total === 0) {
    return <span className="text-12-5 text-muted">{t("releases.page.requirement.traced", { n: r.proven.length, key: r.key })}</span>;
  }
  const proven = r.business.proven.length;
  return (
    <span className="grid gap-1" data-testid="rail-requirement-criteria">
      <CoverageBar
        legend={false}
        segments={[
          { key: "proven", label: t("releases.page.requirement.proven"), count: proven, tone: "ready" },
          { key: "unproven", label: t("releases.page.requirement.unproven"), count: r.business.total - proven, fill: "var(--paper-400)" },
        ]}
      />
      <span className="text-12-5 text-muted">{t("releases.page.requirement.business", { proven, total: r.business.total })}</span>
    </span>
  );
}

/**
 * Its tag on the source host (REQ-63 BC-15), once it shipped: the tag's own name where the host holds
 * it on the shipped commit, else one word for why not. The sentence why is the developer view's.
 */
function TagFact({ r }: { r: Pick<ReleaseDetail, "releasedAt" | "tag"> }) {
  const t = useCopy();
  if (!r.releasedAt) return null;
  const tag = r.tag ?? null;
  return (
    <Fact label={t("releases.standing.label.tag")} testId="standing-tag">
      {tag?.state === "tagged" ? (
        <span className="font-mono text-fg">{tag.name}</span>
      ) : (
        <span className="text-muted">{t(`releases.standing.tag.${tag?.code ?? "none"}`)}</span>
      )}
    </Fact>
  );
}

export function WhereReleaseStands({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  const time = useTimeFormat();
  const s = releaseStandingOf(r, t, time.date);
  return (
    <FactsGroup title={t("releases.standing.title")} testId="release-standing">
      <Fact label={t("releases.standing.label.status")} testId="standing-status">
        {s.status}
      </Fact>
      <Fact label={t("releases.standing.label.approver")} testId="standing-approver">
        {s.approver}
      </Fact>
      <Fact label={t("releases.standing.label.goesTo")} testId="standing-goes-to">
        {s.goesTo}
      </Fact>
      <Fact label={t("releases.standing.label.verified")} testId="standing-verified">
        {s.verified}
      </Fact>
      <TagFact r={r} />
      {s.next ? (
        <p className="pt-1 text-13 font-medium text-warn-11" data-testid="standing-next">
          {t("releases.peek.next", { step: s.next })}
        </p>
      ) : null}
    </FactsGroup>
  );
}

export function RailRequirements({ page, slug }: { page: ReleasePage; slug: string }) {
  const t = useCopy();
  if (page.requirements.length === 0) return null;
  return (
    <FactsGroup title={t("releases.page.group.requirements")} testId="rail-requirements">
      <ul className="grid gap-3">
        {page.requirements.map((r) => (
          <li key={r.key} className="grid gap-0.5" data-testid="rail-requirement" data-key={r.key}>
            <Link href={requirementHref(slug, r.key)} className="text-13 font-medium text-fg hover:text-link hover:underline">
              {r.key} · {r.title}
            </Link>
            <RequirementCount r={r} />
          </li>
        ))}
      </ul>
    </FactsGroup>
  );
}

export function ReleaseRail({ r, page, slug, contents }: { r: ReleaseDetail; page: ReleasePage | undefined; slug: string; contents: ContentsItem[] }) {
  const t = useCopy();
  return (
    <div data-testid="release-rail">
      <WhereReleaseStands r={r} />
      {page ? <RailRequirements page={page} slug={slug} /> : null}
      {/* where the rail falls under the page, the reader's own menu stands in for the contents */}
      <div className="border-t border-line-subtle pt-3.5 max-lg:hidden">
        <ContentsList items={contents} label={t("releases.page.contents")} testId="release-rail-contents" />
      </div>
    </div>
  );
}
