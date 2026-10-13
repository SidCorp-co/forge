
// What a run was given when it opened (REQ-1 BC-3, REQ-4 BC-12): per carried issue, the requirement
// revision it was planned on and the one current then, the pinned design revisions and contract
// versions, the workflow it builds, and its criteria with the BC each traces. Flush rows, one issue
// per block; a run opened before core recorded it says so.

import type { RunGiven, RunGivenIssue } from "@forge/contracts/run-standing";
import { Link } from "@/lib/navigation/router";
import { FactsEmpty, ViewHeading } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 py-2 text-13">
      <span className="w-28 flex-none text-12 text-muted">{label}</span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

function IssueGiven({ issueKey, g, slug }: { issueKey: string; g: RunGivenIssue; slug: string }) {
  const t = useCopy();
  const none = <span className="text-subtle">{t("runs.given.none")}</span>;
  return (
    <section className="mt-4 first:mt-0" data-testid="run-given-issue">
      <ViewHeading>
        <Link href={issueHref(slug, issueKey)} className="font-mono text-link hover:underline">
          {issueKey}
        </Link>
      </ViewHeading>
      <div className="divide-y divide-line-subtle border-y border-line-subtle">
        <Row label={t("runs.given.requirement")}>
          {g.requirement ? (
            <>
              <Link href={requirementHref(slug, g.requirement.key)} className="font-mono font-semibold text-link hover:underline">
                {g.requirement.key}
              </Link>{" "}
              {t("runs.given.revisions", { planned: g.requirement.plannedRevision ?? "–", now: g.requirement.currentRevision ?? "–" })}
            </>
          ) : (
            none
          )}
        </Row>
        <Row label={t("runs.given.designs")}>
          {g.designs.length
            ? g.designs.map((d, i) => (
                <span key={d.flow}>
                  {i > 0 ? " · " : ""}
                  <Link href={workflowHref(slug, d.flow)} className="text-link hover:underline">
                    {d.flow}
                  </Link>{" "}
                  <span className="font-mono">r{d.revision}</span>
                </span>
              ))
            : none}
        </Row>
        <Row label={t("runs.given.contracts")}>
          {g.contracts.length ? <span className="font-mono">{g.contracts.map((c) => `${c.contract} ${c.version}`).join(" · ")}</span> : none}
        </Row>
        <Row label={t("runs.given.builds")}>
          {g.builds ? (
            <>
              <Link href={workflowHref(slug, g.builds.flow)} className="text-link hover:underline">
                {g.builds.flow}
              </Link>{" "}
              <span className="font-mono">{g.builds.approvedRevision === null ? t("runs.given.unapproved") : `r${g.builds.approvedRevision}`}</span>
            </>
          ) : (
            none
          )}
        </Row>
        <Row label={t("runs.given.criteria")}>
          {g.criteria.length ? <span className="font-mono">{g.criteria.map((c) => (c.traces ? `${c.n}→${c.traces}` : `${c.n}`)).join("  ")}</span> : none}
        </Row>
      </div>
    </section>
  );
}

export function RunGivenView({ given, slug }: { given: RunGiven | null; slug: string }) {
  const t = useCopy();
  const entries = given ? Object.entries(given) : [];
  if (!given) return <FactsEmpty>{t("runs.given.notRecorded")}</FactsEmpty>;
  if (entries.length === 0) return <FactsEmpty>{t("runs.given.noIssues")}</FactsEmpty>;
  return (
    <div data-testid="run-given">
      {entries.map(([key, g]) => (
        <IssueGiven key={key} issueKey={key} g={g} slug={slug} />
      ))}
    </div>
  );
}
