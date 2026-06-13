"use client";

// Per-stage skill smoke-verify report (ISS-455). Renders execution/static
// evidence — never the registration `synced` badge: tier-1 = registered +
// present on a bound runner's disk (device-reported hash), tier-2 = the latest
// real canary job's terminal status. Every verdict carries its freshness
// timestamp ("PASS as of …").
import { useMemo } from "react";
import { Badge, Button, Card, CardContent, MonoTag, Spinner, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useRunSmokeVerify, useSkillSmokeVerify } from "../hooks";
import { STAGE_LABELS, type RegisterableStage, type SmokeTier2Entry } from "../types";

interface SmokeVerifyPanelProps {
  projectId: string;
  /** Owner/admin may run the tier-2 canary (it spends agent budget). */
  canManage: boolean;
}

const TIER1_REASON_LABELS: Record<string, string> = {
  not_registered: "no skill registered",
  no_project_skill: "no usable project skill",
  no_bound_runner: "no runner bound",
  no_device_report: "no install report",
  stale_on_runner: "stale on runner",
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as RegisterableStage] ?? stage;
}

function tier2Badge(entry: SmokeTier2Entry) {
  if (entry.status === "PASS") return <Badge tone="green">canary PASS</Badge>;
  if (entry.status === "FAIL") return <Badge tone="red">canary FAIL</Badge>;
  return <Badge tone="amber">canary running…</Badge>;
}

export function SmokeVerifyPanel({ projectId, canManage }: SmokeVerifyPanelProps) {
  const reportQ = useSkillSmokeVerify(projectId);
  const run = useRunSmokeVerify(projectId);

  const report = reportQ.data;
  const tier2ByStage = useMemo(
    () => new Map((report?.tier2 ?? []).map((e) => [e.stage, e])),
    [report?.tier2],
  );
  const passCount = report?.tier1.filter((e) => e.status === "PASS").length ?? 0;
  const canaryPending = (report?.tier2 ?? []).some((e) => e.status === "PENDING");

  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="fg-body font-semibold text-fg">Skill verification</p>
              {report && (
                <Badge tone={passCount === report.tier1.length ? "green" : "amber"}>
                  {passCount}/{report.tier1.length} PASS
                </Badge>
              )}
            </div>
            <p className="fg-caption mt-1 text-muted">
              Per-stage evidence that each pipeline skill is registered and present on the bound
              runner — not the registration badge.
              {report && ` Checked ${formatRelativeTime(report.generatedAt)}.`}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon="rerun"
              disabled={run.isPending}
              onClick={() => run.mutate({ tier: 1 })}
            >
              Verify skills
            </Button>
            {canManage && (
              <Tooltip label="Experimental — dispatches one real agent canary job per registered stage on the bound runner (spends agent budget).">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="play"
                  disabled={run.isPending || canaryPending}
                  onClick={() => run.mutate({ tier: 2 })}
                >
                  Run full canary
                </Button>
              </Tooltip>
            )}
          </div>
        </div>

        {reportQ.isLoading && (
          <div className="mt-3 flex items-center gap-2">
            <Spinner size={14} />
            <span className="fg-caption text-muted">Running checks…</span>
          </div>
        )}

        {reportQ.isError && (
          <p className="fg-caption mt-3 text-red-600">
            Couldn&apos;t load the report: {formatApiError(reportQ.error)}
          </p>
        )}

        {report && (
          <ul className="mt-3 divide-y divide-line">
            {report.tier1.map((entry) => {
              const t2 = tier2ByStage.get(entry.stage);
              return (
                <li key={entry.stage} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="fg-body-sm w-24 flex-none font-medium text-fg">
                    {stageLabel(entry.stage)}
                  </span>
                  <MonoTag>{entry.stage}</MonoTag>
                  {entry.skillName && <MonoTag hue="cobalt">{entry.skillName}</MonoTag>}
                  {entry.status === "PASS" ? (
                    <Badge tone="green">PASS</Badge>
                  ) : (
                    <Tooltip label={entry.detail ?? entry.reason ?? "failed"}>
                      <span>
                        <Badge tone={entry.reason === "no_device_report" ? "amber" : "red"}>
                          FAIL · {TIER1_REASON_LABELS[entry.reason ?? ""] ?? entry.reason}
                        </Badge>
                      </span>
                    </Tooltip>
                  )}
                  {t2 &&
                    (t2.reason ? (
                      <Tooltip label={t2.reason}>
                        <span>{tier2Badge(t2)}</span>
                      </Tooltip>
                    ) : (
                      tier2Badge(t2)
                    ))}
                  <span className="fg-caption ml-auto whitespace-nowrap text-subtle">
                    {t2?.checkedAt
                      ? `canary ${t2.status === "PASS" ? "passed" : "checked"} ${formatRelativeTime(t2.checkedAt)}`
                      : entry.status === "PASS" && entry.evidenceAt
                        ? `as of ${formatRelativeTime(entry.evidenceAt)}`
                        : `checked ${formatRelativeTime(entry.checkedAt)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
