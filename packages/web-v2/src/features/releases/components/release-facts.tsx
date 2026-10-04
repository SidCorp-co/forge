"use client";

import { RELEASE_PROOF_LABELS } from "@forge/contracts/releases";
import {
  ActorChip,
  CoverageBar,
  Fact,
  FactsEmpty,
  FactsGroup,
  PersonChip,
  StatusBadge,
  Tooltip,
} from "@/design";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import type { ReleaseApprovalView, ReleaseDetail } from "../types";
import { shortSha } from "./release-bits";

function Decision({ a }: { a: ReleaseApprovalView }) {
  if (!a.decision) return <span className="text-muted">Not decided</span>;
  return (
    <span className="grid gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusBadge family="release" value={a.decision} />
        {a.decidedBy ? <ActorChip name={a.decidedBy.name} kind={a.decidedBy.kind} /> : null}
      </span>
      {a.reason ? <span className="text-12-5 text-muted">{a.reason}</span> : null}
    </span>
  );
}

export function ReleaseFacts({ r }: { r: ReleaseDetail }) {
  const c = r.criteria;
  const a = r.approval;
  return (
    <div data-testid="release-facts">
      <FactsGroup title="Proof" testId="facts-proof">
        <Fact label="Criteria">
          {c.total === 0 ? (
            <span className="text-muted">{RELEASE_PROOF_LABELS.unrecorded}</span>
          ) : (
            <span className="grid w-full gap-1.5">
              <span className="text-13">
                {c.proven} of {c.total} proven
              </span>
              <CoverageBar
                legend={false}
                segments={[
                  { key: "proven", label: "Proven", count: c.proven, tone: "ready" },
                  { key: "failing", label: "Failing", count: c.failing, tone: "err" },
                  { key: "open", label: "Not judged yet", count: c.open, tone: "neutral" },
                ]}
              />
            </span>
          )}
        </Fact>
      </FactsGroup>

      {r.approvalRequired || a ? (
        <FactsGroup title="Approval" testId="facts-approval">
          <Fact label="Policy">
            <Tooltip label="Set by the project document: no production act is taken until a person other than the asker approves" multiline>
              <span>{r.approvalRequired ? "Required" : "Asked for by the run"}</span>
            </Tooltip>
          </Fact>
          {a ? (
            <>
              <Fact label="Asked by">
                <span className="flex flex-wrap items-center gap-1.5">
                  <ActorChip name={a.requestedBy.name} kind={a.requestedBy.kind} />
                  <span className="text-muted" title={formatStamp(a.requestedAt)}>
                    {formatRelativeTime(a.requestedAt)}
                  </span>
                </span>
              </Fact>
              <Fact label="Decision">
                <Decision a={a} />
              </Fact>
            </>
          ) : null}
          {!a || a.decision === null ? (
            <Fact label="Can decide">
              {r.approvers.length === 0 ? (
                <span className="text-muted">No other admin</span>
              ) : (
                <span className="grid gap-1">
                  {r.approvers.map((p) => (
                    <PersonChip key={p.id} name={p.name} />
                  ))}
                </span>
              )}
            </Fact>
          ) : null}
        </FactsGroup>
      ) : null}

      <FactsGroup title="Run" testId="facts-run">
        {r.owner && r.ownerAct === "Cut" ? (
          <Fact label="Cut by">
            <ActorChip name={r.owner.name} kind={r.owner.kind} />
          </Fact>
        ) : null}
        {r.openedAt ? (
          <Fact label="Cut">
            <span title={formatStamp(r.openedAt)}>{formatRelativeTime(r.openedAt)}</span>
          </Fact>
        ) : null}
        {r.releasedAt ? (
          <Fact label="Shipped">
            <span title={formatStamp(r.releasedAt)}>{formatRelativeTime(r.releasedAt)}</span>
          </Fact>
        ) : null}
        <Fact label="Head">
          {r.head ? (
            <span className="font-mono text-12" title={r.head}>
              {shortSha(r.head)}
            </span>
          ) : (
            <span className="text-muted">None yet</span>
          )}
        </Fact>
        {r.state === "draft" ? <FactsEmpty>Not cut yet: no run holds these issues.</FactsEmpty> : null}
      </FactsGroup>

      {r.production ? (
        <FactsGroup title="Production" testId="facts-production">
          <Fact label="Environment">{r.production.name ?? "Not declared"}</Fact>
          {r.state === "shipped" ? <Fact label="Serving">{r.current ? "This release" : "A later release"}</Fact> : null}
          {r.production.url ? (
            <Fact label="Address">
              <a className="truncate text-link hover:underline" href={r.production.url} target="_blank" rel="noreferrer">
                {r.production.url.replace(/^https?:\/\//, "")}
              </a>
            </Fact>
          ) : null}
        </FactsGroup>
      ) : null}
    </div>
  );
}
