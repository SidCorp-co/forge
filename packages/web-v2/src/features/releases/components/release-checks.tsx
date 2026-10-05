"use client";

import { useState } from "react";
import { StatusBadge, ToneBadge, ViewHeading } from "@/design";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import type { ReleaseApprovalView, ReleaseAttemptView, ReleaseDetail } from "../types";
import { DisclosureToggle, shortSha } from "./release-bits";

const STAGE_LABEL: Record<ReleaseAttemptView["stage"], string> = {
  promote: "Promote",
  deploy: "Deploy",
  verify: "Verify",
  repair: "Repair",
};

function verdictBadge(a: ReleaseAttemptView) {
  if (a.verdict === "ok") return <ToneBadge tone="ready" label="Passed" title="ok" />;
  if (a.verdict === "failed") return <ToneBadge tone="err" label="Failed" title="failed" />;
  if (a.verdict === "unverified") return <ToneBadge tone="you" label="Unverified" title="unverified: nothing could re-read production" />;
  return <ToneBadge tone="run" label="Running" title="no verdict yet" pulse />;
}

function Attempt({ a }: { a: ReleaseAttemptView }) {
  const [open, setOpen] = useState(false);
  const hasMore = a.readings.length > 0 || a.verdictReason;
  return (
    <li className="border-b border-line-subtle py-2.5 text-13" data-testid="release-attempt" data-stage={a.stage}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-[72px] font-semibold">{STAGE_LABEL[a.stage]}</span>
        {verdictBadge(a)}
        {a.health ? <span className="text-12 text-muted">Production {a.health === "up" ? "up" : "down"}</span> : null}
        {a.commit ? (
          <span className="font-mono text-12 text-muted" title={a.commit}>
            {shortSha(a.commit)}
          </span>
        ) : null}
        <span className="ml-auto text-12 text-subtle" title={formatStamp(a.startedAt)}>
          {formatRelativeTime(a.startedAt)}
        </span>
        {hasMore ? (
          <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12">
            Details
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
  return (
    <li className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13" data-testid="release-approval">
      <span className="flex flex-wrap items-center gap-2">
        <StatusBadge family="release" value={a.decision ?? "pending"} />
        <span className="text-muted">
          Asked by {a.requestedBy.name}, <span title={formatStamp(a.requestedAt)}>{formatRelativeTime(a.requestedAt)}</span>
          {a.decidedBy && a.decidedAt ? (
            <>
              {" "}
              · decided by {a.decidedBy.name}, <span title={formatStamp(a.decidedAt)}>{formatRelativeTime(a.decidedAt)}</span>
            </>
          ) : null}
        </span>
      </span>
      <span className="text-12-5 text-muted" title={a.evidence.commit}>
        Evidence from {a.evidence.environment} at {shortSha(a.evidence.commit)}: {a.evidence.reading}
      </span>
      {a.note ? <span className="text-12-5">{a.note}</span> : null}
      {a.reason ? <span className="text-12-5 text-muted">Reason: {a.reason}</span> : null}
    </li>
  );
}

export function ChecksPane({ r }: { r: ReleaseDetail }) {
  const crossed = r.bounds.bounds.filter((b) => b.crossed);
  if (r.attempts.length === 0 && r.approvals.length === 0) {
    return <p className="text-13 text-subtle">No run has recorded a check on this release yet.</p>;
  }
  return (
    <div className="grid gap-8" data-testid="view-checks">
      {crossed.length > 0 ? (
        <section aria-label="Bounds">
          <ViewHeading>Bounds crossed</ViewHeading>
          <ul className="grid gap-1 text-13">
            {crossed.map((b) => (
              <li key={b.name}>{b.why}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.approvals.length > 0 ? (
        <section aria-label="Approvals">
          <ViewHeading>Approval</ViewHeading>
          <ul className="border-t border-line-subtle">
            {[...r.approvals].reverse().map((a) => (
              <Approval key={a.id} a={a} />
            ))}
          </ul>
        </section>
      ) : null}
      {r.attempts.length > 0 ? (
        <section aria-label="Batch run">
          <ViewHeading>Batch run</ViewHeading>
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
