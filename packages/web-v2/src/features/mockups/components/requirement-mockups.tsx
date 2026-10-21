import { useState } from "react";
import { Button, FactsEmpty, FactsGroup, StatusBadge } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useMockups, useOpenMockup } from "../hooks";
import type { MockupTarget } from "../types";
import { MockupViewerHost, ProposeMockup } from "./mockups-panel";

/**
 * A requirement's mockups under its properties (REQ-49 BC-7): each by name with its status and round,
 * opening full screen; and Add mockup, which proposes one on the open draft, else the current
 * revision. This is the page's one full-screen host.
 */
export function RequirementMockups({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const t = useCopy();
  const target: MockupTarget = { type: "requirement", key: reqKey };
  const q = useMockups(projectId, target);
  const view = useOpenMockup();
  const [adding, setAdding] = useState(false);
  const rows = q.data?.mockups ?? [];
  // the newest revision of each mockup stands for it; earlier ones are read from the viewer
  const latest = rows.filter((m) => !m.revisedBy);
  return (
    <FactsGroup title={t("common.mockups.title")} count={q.data?.open ? t("common.mockups.waiting", { n: q.data.open }) : undefined} testId="requirement-mockups">
      {latest.length ? (
        <ul className="grid divide-y divide-line-subtle" data-testid="requirement-mockup-list">
          {latest.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => view.open(m.key)}
                className="grid w-full gap-1 py-2 text-left hover:bg-hover focus-visible:shadow-focus focus-visible:outline-none"
                data-testid="requirement-mockup"
                data-key={m.key}
              >
                <span className="truncate text-13 font-medium text-fg">{m.caption ?? m.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-12 text-muted">
                  <span className="font-mono">{m.key}</span>
                  <StatusBadge family="mockup" value={m.status} />
                  {m.round > 1 ? <span>{t("common.mockups.round", { n: m.round })}</span> : null}
                  {m.comments.open ? <span>{t("common.mockups.openComments", { n: m.comments.open })}</span> : null}
                  {view.subject === m.key && !view.full ? <span className="text-accent-text">{t("common.mockups.chatAbout")}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : q.isSuccess ? (
        <FactsEmpty>{t("common.mockups.noneRequirement")}</FactsEmpty>
      ) : null}
      {adding ? (
        <div className="mt-2">
          <ProposeMockup projectId={projectId} target={target} />
        </div>
      ) : (
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => setAdding(true)} data-testid="requirement-mockup-add">
          {t("common.mockups.add")}
        </Button>
      )}
      <MockupViewerHost projectId={projectId} slug={slug} rows={rows} />
    </FactsGroup>
  );
}
