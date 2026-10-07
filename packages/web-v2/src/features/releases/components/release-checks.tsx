"use client";

import { useState } from "react";
import { StatusBadge, ToneBadge, ViewHeading } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import type { ReleaseApprovalView, ReleaseAttemptView, ReleaseDetail } from "../types";
import { DisclosureToggle, shortSha } from "./release-bits";

const STAGE_LABEL: Record<ReleaseAttemptView["stage"], ProductCopyKey> = {
  deploy: "releases.stage.deploy",
  verify: "releases.stage.verify",
};

function verdictBadge(a: ReleaseAttemptView, t: Copy) {
  if (a.verdict === "ok") return <ToneBadge tone="ready" label={t("releases.verdict.passed")} title="ok" />;
  if (a.verdict === "failed") return <ToneBadge tone="err" label={t("releases.verdict.failed")} title="failed" />;
  if (a.verdict === "unverified") return <ToneBadge tone="you" label={t("releases.verdict.unverified")} title={`unverified: ${t("releases.verdict.unverifiedHint")}`} />;
  return <ToneBadge tone="run" label={t("releases.verdict.running")} title={t("releases.verdict.runningHint")} pulse />;
}

function Attempt({ a }: { a: ReleaseAttemptView }) {
  const t = useCopy();
  const time = useTimeFormat();
  const [open, setOpen] = useState(false);
  const hasMore = a.readings.length > 0 || a.verdictReason;
  return (
    <li className="border-b border-line-subtle py-2.5 text-13" data-testid="release-attempt" data-stage={a.stage}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-[72px] font-semibold">{t(STAGE_LABEL[a.stage])}</span>
        {verdictBadge(a, t)}
        {a.health ? <span className="text-12 text-muted">{t(a.health === "up" ? "releases.productionUp" : "releases.productionDown")}</span> : null}
        {a.commit ? (
          <span className="font-mono text-12 text-muted" title={a.commit}>
            {shortSha(a.commit)}
          </span>
        ) : null}
        <span className="ml-auto text-12 text-subtle" title={time.dateTime(a.startedAt)}>
          {time.relative(a.startedAt)}
        </span>
        {hasMore ? (
          <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12">
            {t("releases.details")}
          </DisclosureToggle>
        ) : null}
      </div>
      {a.verdictReason ? <p className="mt-1 text-12-5 text-muted">{a.verdictReason}</p> : null}
      {open ? (
        <div className="mt-2 grid gap-1.5 text-12-5">
          {a.identity ? <p className="text-muted">{a.identity}</p> : null}
          {a.readings.length > 0 ? (
            <ul className="list-disc pl-5 text-muted">
              {a.readings.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Approval({ a }: { a: ReleaseApprovalView }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <li className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13" data-testid="release-approval">
      <span className="flex flex-wrap items-center gap-2">
        <StatusBadge family="release" value={a.decision ?? "pending"} />
        <span className="text-muted">
          {t("releases.askedBy", { who: a.requestedBy.name })} <span title={time.dateTime(a.requestedAt)}>{time.relative(a.requestedAt)}</span>
          {a.decidedBy && a.decidedAt ? (
            <>
              {" "}
              · {t("releases.decidedBy", { who: a.decidedBy.name })} <span title={time.dateTime(a.decidedAt)}>{time.relative(a.decidedAt)}</span>
            </>
          ) : null}
        </span>
      </span>
      <span className="text-12-5 text-muted" title={a.evidence.commit}>
        {t("releases.evidenceFrom", { env: a.evidence.environment, sha: shortSha(a.evidence.commit) })} {a.evidence.reading}
      </span>
      {a.note ? <span className="text-12-5">{a.note}</span> : null}
      {a.reason ? <span className="text-12-5 text-muted">{t("releases.reason")} {a.reason}</span> : null}
    </li>
  );
}

export function ChecksPane({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  if (r.attempts.length === 0 && r.approvals.length === 0) {
    return <p className="text-13 text-subtle">{t("releases.checksEmpty")}</p>;
  }
  return (
    <div className="grid gap-8" data-testid="view-checks">
      {r.approvals.length > 0 ? (
        <section aria-label={t("releases.approvals")}>
          <ViewHeading>{t("releases.approval")}</ViewHeading>
          <ul className="border-t border-line-subtle">
            {[...r.approvals].reverse().map((a) => (
              <Approval key={a.id} a={a} />
            ))}
          </ul>
        </section>
      ) : null}
      {r.attempts.length > 0 ? (
        <section aria-label={t("releases.batchRun")}>
          <ViewHeading>{t("releases.batchRun")}</ViewHeading>
          <ol className="border-t border-line-subtle">
            {r.attempts.map((a) => (
              <Attempt key={a.id} a={a} />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
