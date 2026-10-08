"use client";

import Link from "next/link";
import { Fact, FactsEmpty, FactsGroup, NotAvailable, StatusBadge } from "@/design";
import { FeedbackRailItem } from "@/features/feedback/components/feedback-rail-item";
import { useCopy } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { moduleHref } from "@/lib/routes/modules";
import type { ModuleActiveIssue, ModuleDetail } from "../types";

const SHOWN = 8;

function IssueRow({ i, slug }: { i: ModuleActiveIssue; slug: string }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-issue">
      <Link href={issueHref(slug, i.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
        {i.key}
      </Link>
      <span className="min-w-0 flex-1 truncate" title={`${i.title} · ${i.modulePath}`}>
        {i.title}
      </span>
      <StatusBadge family="issue" value={i.status} step={i.step} tone={i.tone} />
    </li>
  );
}

function ActiveIssues({ d, slug }: { d: ModuleDetail; slug: string }) {
  const t = useCopy();
  const first = d.issues.slice(0, SHOWN);
  const rest = d.issues.slice(SHOWN);
  return (
    <FactsGroup title={t("modules.facts.activeIssues")} count={d.issues.length ? t("modules.openCount", { n: d.issues.length }) : undefined} testId="facts-issues">
      {d.issues.length === 0 ? (
        <FactsEmpty>{t("modules.facts.noOpenIssues")}</FactsEmpty>
      ) : (
        <>
          <ul className="grid gap-1">
            {first.map((i) => (
              <IssueRow key={i.key} i={i} slug={slug} />
            ))}
          </ul>
          {rest.length ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer select-none text-12-5 font-medium text-muted hover:text-fg">{t("modules.facts.showMore", { n: rest.length })}</summary>
              <ul className="mt-1 grid gap-1">
                {rest.map((i) => (
                  <IssueRow key={i.key} i={i} slug={slug} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </FactsGroup>
  );
}

/** The module's relations and properties: the sticky rail of its full page and the body of its peek, one component, so each fact is stated once. */
export function ModuleFacts({ d, slug }: { d: ModuleDetail; slug: string }) {
  const t = useCopy();
  const m = d.module;
  return (
    <div data-testid="module-facts">
      <ActiveIssues d={d} slug={slug} />

      <FactsGroup title={t("modules.facts.requirements")} count={d.standing.requirements.length ? t("modules.facts.traced", { n: d.standing.requirements.length }) : undefined} testId="facts-requirements">
        {d.standing.requirements.length === 0 ? (
          <FactsEmpty>{t("modules.facts.noRequirement")}</FactsEmpty>
        ) : (
          <ul className="grid gap-1">
            {d.standing.requirements.map((r) => (
              <li key={r.key} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-requirement">
                <Link href={requirementHref(slug, r.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                  {r.key}
                </Link>
                <span className="min-w-0 flex-1 truncate" title={r.title}>
                  {r.title}
                </span>
                {r.criteria.length ? (
                  <span className="flex-none font-mono text-11-5 text-subtle" title={t("modules.facts.criteria", { codes: r.criteria.join(", ") })}>
                    {r.criteria.join(" ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </FactsGroup>

      <FactsGroup title={t("modules.facts.openFeedback")} count={d.feedback.length ? t("modules.openCount", { n: d.feedback.length }) : undefined} testId="facts-feedback">
        {d.feedback.length === 0 ? (
          <FactsEmpty>{t("modules.facts.noFeedback")}</FactsEmpty>
        ) : (
          <ul className="grid gap-1">
            {d.feedback.map((f) => (
              <FeedbackRailItem key={f.key} slug={slug} itemKey={f.key} title={f.title} phase={f.phase} />
            ))}
          </ul>
        )}
      </FactsGroup>

      <FactsGroup title={t("contracts.title")} testId="facts-contracts">
        <FactsEmpty>
          <NotAvailable reason={d.contracts.reason} />
        </FactsEmpty>
      </FactsGroup>

      <FactsGroup title={t("contracts.facts.properties")} testId="facts-properties">
        <Fact label={t("modules.facts.owner")}>
          <NotAvailable reason={d.owner.reason} />
        </Fact>
        <Fact label={t("modules.facts.parent")}>
          {m.parent ? (
            <Link href={moduleHref(slug, m.parent.slug)} className="font-mono text-12 text-link hover:underline">
              {m.parent.path}
            </Link>
          ) : (
            <span className="text-subtle">{t("modules.facts.root")}</span>
          )}
        </Fact>
        <Fact label={t("modules.facts.children")}>
          {m.children.length ? (
            m.children.map((c) => (
              <Link key={c.id} href={moduleHref(slug, c.slug)} className="font-mono text-12 text-link hover:underline">
                {c.path}
              </Link>
            ))
          ) : (
            <span className="text-subtle">{t("modules.facts.none")}</span>
          )}
        </Fact>
        <Fact label={t("modules.facts.knowledge")}>
          {d.purpose.available ? (
            <span className="min-w-0 truncate font-mono text-12" title={d.purpose.value.title}>
              {d.purpose.value.entrySlug}
            </span>
          ) : (
            <NotAvailable reason={d.purpose.reason} />
          )}
        </Fact>
      </FactsGroup>
    </div>
  );
}
