"use client";

import { useState } from "react";
import {
  StatusBadge,
  Button,
  PageSection,
  PageSectionBody,
  PageSectionHeader,
  PageSectionTitle,
  ConfirmDialog,
  MonoTag,
  Skeleton,
} from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { useReapJob } from "../hooks";
import { formatSince } from "../format";
import type { AdminAlert, AdminAlertStatus } from "../types";

/** The alerts core raises, each titled by `operator.alert.<id>`; an unknown one reads its key. */
const ALERT_IDS = new Set(["A1", "A2", "A3", "A4", "A5", "A6"] as const);
const isAlertId = (id: string): id is "A1" | "A2" | "A3" | "A4" | "A5" | "A6" => (ALERT_IDS as Set<string>).has(id);

const STATUS_RANK: Record<AdminAlertStatus, number> = { crit: 0, warn: 1, ok: 2 };

function sortAlerts(alerts: readonly AdminAlert[]): AdminAlert[] {
  return [...alerts].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id.localeCompare(b.id),
  );
}

export function AlertFeedSkeleton() {
  const t = useCopy();
  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("operator.alerts.title")}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton variant="circle" className="h-2 w-2" />
            <Skeleton variant="text" className="w-32" />
            <Skeleton variant="text" className="w-48" />
          </div>
        ))}
      </PageSectionBody>
    </PageSection>
  );
}

function ReapButton({ jobId, label }: { jobId: string; label: string }) {
  const t = useCopy();
  const [confirming, setConfirming] = useState(false);
  const { toast } = useToast();
  const reap = useReapJob();

  function confirm() {
    reap.mutate(jobId, {
      onSuccess: () => {
        setConfirming(false);
        toast({ tone: "success", title: t("operator.alerts.reaped"), description: label });
      },
      onError: (err) => {
        setConfirming(false);
        toast({ tone: "error", title: t("operator.alerts.reapFailed"), description: formatApiError(err) });
      },
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" icon="x" onClick={() => setConfirming(true)}>
        {t("operator.alerts.reap")}
      </Button>
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={t("operator.alerts.reapConfirm")}
        message={
          <>
            <span className="block">{label}</span>
            <span className="mt-2 block">{t("operator.alerts.reapConfirm.lost")}</span>
          </>
        }
        confirmLabel={t("operator.alerts.reapJob")}
        loading={reap.isPending}
        onConfirm={confirm}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function AlertRow({ alert }: { alert: AdminAlert }) {
  const t = useCopy();
  const since = formatSince(alert.since);
  return (
    <li className="flex flex-col gap-2 border-b border-line-subtle py-3 last:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="fg-label">{isAlertId(alert.id) ? t(`operator.alert.${alert.id}`) : alert.key}</span>
        <StatusBadge family="alert" value={alert.status} />
        {alert.count > 0 && <span className="fg-caption font-mono">{alert.count}</span>}
        {since && <span className="fg-caption ml-auto">{t("operator.alerts.oldest", { since })}</span>}
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
  const t = useCopy();
  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("operator.alerts.title")}</PageSectionTitle>
        <span className="fg-caption">{t("operator.alerts.critFirst")}</span>
      </PageSectionHeader>
      <PageSectionBody>
        <ul className="flex flex-col">
          {sortAlerts(alerts).map((a) => (
            <AlertRow key={a.id} alert={a} />
          ))}
        </ul>
      </PageSectionBody>
    </PageSection>
  );
}
