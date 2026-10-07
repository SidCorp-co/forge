"use client";

import type { ScopeForecast } from "@forge/contracts/forecast";
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
import { ScopeForecastLine } from "@/features/forecast/components/forecast-line";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ReleaseApprovalView, ReleaseDetail } from "../types";
import { shortSha } from "./release-bits";

function Decision({ a }: { a: ReleaseApprovalView }) {
  const t = useCopy();
  if (!a.decision) return <span className="text-muted">{t("releases.notDecided")}</span>;
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

export function ApprovalFacts({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  const time = useTimeFormat();
  const a = r.approval;
  return (
    <FactsGroup title={t("releases.approval")} testId="facts-approval">
      <Fact label={t("releases.policy")}>
        <Tooltip label={t("releases.policyHint")} multiline>
          <span>{r.approvalRequired ? t("releases.policyRequired") : t("releases.policyAsked")}</span>
        </Tooltip>
      </Fact>
      {a ? (
        <>
          <Fact label={t("releases.factAskedBy")}>
            <span className="flex flex-wrap items-center gap-1.5">
              <ActorChip name={a.requestedBy.name} kind={a.requestedBy.kind} />
              <span className="text-muted" title={time.dateTime(a.requestedAt)}>
                {time.relative(a.requestedAt)}
              </span>
            </span>
          </Fact>
          <Fact label={t("releases.decision")}>
            <Decision a={a} />
          </Fact>
        </>
      ) : null}
      {!a || a.decision === null ? (
        <Fact label={t("releases.canDecide")}>
          {r.approvers.length === 0 ? (
            <span className="text-muted">{t("releases.noOtherAdmin")}</span>
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
  );
}

/** On a phone the rail falls below the whole page, so the forecast and the approval ride the top of the main column too; the rail hides its own copies there. */
export function ReleasePhoneStanding({ r, forecast }: { r: ReleaseDetail; forecast?: ScopeForecast | undefined }) {
  const t = useCopy();
  const showForecast = r.state === "draft" && forecast?.forecast;
  const showApproval = r.approvalRequired || r.approval;
  if (!showForecast && !showApproval) return null;
  return (
    <div className="hidden border-b border-line-subtle bg-surface px-4 py-3 max-sm:block" data-testid="phone-standing">
      {showForecast && forecast ? (
        <FactsGroup title={t("releases.forecast")} testId="phone-forecast">
          <Fact label={t("releases.forecast")} testId="phone-release-forecast">
            <ScopeForecastLine scope={forecast} />
          </Fact>
        </FactsGroup>
      ) : null}
      {showApproval ? <ApprovalFacts r={r} /> : null}
    </div>
  );
}

export function ReleaseFacts({ r, forecast }: { r: ReleaseDetail; forecast?: ScopeForecast | undefined }) {
  const t = useCopy();
  const label = useLabel();
  const time = useTimeFormat();
  const c = r.criteria;
  const a = r.approval;
  return (
    <div data-testid="release-facts">
      <FactsGroup title={t("releases.proof")} testId="facts-proof">
        <Fact label={t("releases.tab.criteria")}>
          {c.total === 0 ? (
            <span className="text-muted">{label("releaseProof", "unrecorded")}</span>
          ) : (
            <span className="grid w-full gap-1.5">
              <span className="text-13">{t("releases.provenOf", { proven: c.proven, total: c.total })}</span>
              <CoverageBar
                legend={false}
                segments={[
                  { key: "proven", label: label("releaseProof", "proven"), count: c.proven, tone: "ready" },
                  { key: "failing", label: label("releaseProof", "failing"), count: c.failing, tone: "err" },
                  { key: "open", label: label("releaseProof", "open"), count: c.open, tone: "neutral" },
                ]}
              />
            </span>
          )}
        </Fact>
      </FactsGroup>

      {r.approvalRequired || a ? (
        <div className="max-sm:hidden">
          <ApprovalFacts r={r} />
        </div>
      ) : null}

      <FactsGroup title={t("releases.run")} testId="facts-run">
        {r.owner && r.ownerAct === "Cut" ? (
          <Fact label={t("releases.cutBy")}>
            <ActorChip name={r.owner.name} kind={r.owner.kind} />
          </Fact>
        ) : null}
        {r.openedAt ? (
          <Fact label={t("releases.factCut")}>
            <span title={time.dateTime(r.openedAt)}>{time.relative(r.openedAt)}</span>
          </Fact>
        ) : null}
        {r.releasedAt ? (
          <Fact label={label("releaseState", "shipped")}>
            <span title={time.dateTime(r.releasedAt)}>{time.relative(r.releasedAt)}</span>
          </Fact>
        ) : null}
        <Fact label={t("releases.head")}>
          {r.head ? (
            <span className="font-mono text-12" title={r.head}>
              {shortSha(r.head)}
            </span>
          ) : (
            <span className="text-muted">{t("releases.noneYet")}</span>
          )}
        </Fact>
        {r.state === "draft" && forecast?.forecast ? (
          <div className="max-sm:hidden">
            <Fact label={t("releases.forecast")} testId="facts-release-forecast">
              <ScopeForecastLine scope={forecast} />
            </Fact>
          </div>
        ) : null}
        {r.state === "draft" ? <FactsEmpty>{t("releases.notCutYet")}</FactsEmpty> : null}
      </FactsGroup>

      {r.production ? (
        <FactsGroup title={t("releases.production")} testId="facts-production">
          <Fact label={t("releases.environment")}>{r.production.name ?? t("releases.notDeclared")}</Fact>
          {r.state === "shipped" ? <Fact label={t("releases.serving")}>{r.current ? t("releases.thisRelease") : t("releases.laterRelease")}</Fact> : null}
          {r.verifiedBy ? (
            <Fact label={t("releases.verifiedBy")} testId="release-verified-by">
              {t(`releases.verifiedBy.${r.verifiedBy.kind}`, { provider: r.verifiedBy.provider ?? "" })}
            </Fact>
          ) : null}
          {r.production.url ? (
            <Fact label={t("releases.address")}>
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
