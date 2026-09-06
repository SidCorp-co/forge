"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  MonoTag,
  Skeleton,
} from "@/design";
import { TONE_META } from "@/design/status";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { useReapJob } from "../hooks";
import { formatSince } from "../format";
import type { AdminAlert, AdminAlertStatus } from "../types";

const ALERT_TITLE: Record<string, string> = {
  A1: "Orphan jobs",
  A2: "Stuck jobs",
  A3: "Runner-starved projects",
  A4: "Spend spike",
  A5: "Automation failing",
};

const STATUS_TONE: Record<AdminAlertStatus, "green" | "amber" | "red"> = {
  ok: "green",
  warn: "amber",
  crit: "red",
};

const STATUS_DOT: Record<AdminAlertStatus, string> = {
  ok: TONE_META.success.dot,
  warn: TONE_META.attention.dot,
  crit: TONE_META.failure.dot,
};

// cm:guard only A2 carries an action — A1 is a bookkeeping invariant a reap does not fix, and A3/A4/A5 name a project, a budget or a schedule, none of which is a job id `POST /jobs/:id/cancel` would accept
// cm:guard the feed's order is crit > warn > ok and nothing else — an operator reads top-down and stops, so an alert sorted by id would bury a crit A5 under four ok rows
const STATUS_RANK: Record<AdminAlertStatus, number> = { crit: 0, warn: 1, ok: 2 };

export function openAlertCount(alerts: readonly AdminAlert[]): number {
  return alerts.filter((a) => a.status !== 'ok').length;
}

export function sortAlerts(alerts: readonly AdminAlert[]): AdminAlert[] {
  return [...alerts].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id.localeCompare(b.id),
  );
}

export function AlertFeedSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton variant="circle" className="h-2 w-2" />
            <Skeleton variant="text" className="w-32" />
            <Skeleton variant="text" className="w-48" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ReapButton({ jobId, label }: { jobId: string; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const { toast } = useToast();
  const reap = useReapJob();

  function confirm() {
    reap.mutate(jobId, {
      onSuccess: () => {
        setConfirming(false);
        toast({ tone: "success", title: "Job reaped", description: label });
      },
      onError: (err) => {
        setConfirming(false);
        toast({ tone: "error", title: "Couldn't reap the job", description: formatApiError(err) });
      },
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" icon="x" onClick={() => setConfirming(true)}>
        Reap
      </Button>
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title="Reap this job?"
        message={
          <>
            <span className="block">{label}</span>
            <span className="mt-2 block">
              The job is cancelled and its agent stops. Work it has not written back is lost.
            </span>
          </>
        }
        confirmLabel="Reap job"
        loading={reap.isPending}
        onConfirm={confirm}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function AlertRow({ alert }: { alert: AdminAlert }) {
  const since = formatSince(alert.since);
  return (
    <li className="flex flex-col gap-2 border-b border-line-subtle py-3 last:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-pill"
          style={{ background: STATUS_DOT[alert.status] }}
        />
        <span className="fg-label">{ALERT_TITLE[alert.id] ?? alert.key}</span>
        <Badge tone={STATUS_TONE[alert.status]}>{alert.status}</Badge>
        {alert.count > 0 && <span className="fg-caption font-mono">{alert.count}</span>}
        {since && <span className="fg-caption ml-auto">oldest {since}</span>}
      </div>
      <p className="fg-body-sm pl-4">{alert.detail}</p>

      {alert.entities.length > 0 && (
        <ul className="flex flex-col gap-1.5 pl-4">
          {alert.entities.map((e) => (
            <li key={`${e.kind}:${e.ref}`} className="flex flex-wrap items-center gap-2">
              <MonoTag>{e.ref.slice(0, 8)}</MonoTag>
              <span className="fg-body-sm min-w-0 truncate">{e.label}</span>
              {alert.id === "A2" && e.kind === "job" && (
                <span className="ml-auto">
                  <ReapButton jobId={e.ref} label={e.label} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function AlertFeed({ alerts }: { alerts: readonly AdminAlert[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts</CardTitle>
        <span className="fg-caption">crit first</span>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {sortAlerts(alerts).map((a) => (
            <AlertRow key={a.id} alert={a} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
