import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getNotifications } from "@/lib/api";
import type { Notification } from "@/lib/types";
import type { PmEscalationPayload } from "./types";

export interface PmEscalation extends PmEscalationPayload {
  notificationId: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  read: boolean;
}

function parseEscalation(n: Notification): PmEscalation | null {
  if (n.type !== "pm_escalation" || !n.body) return null;
  try {
    const parsed = JSON.parse(n.body) as Partial<PmEscalationPayload>;
    if (!parsed?.decisionId || !Array.isArray(parsed.options)) return null;
    return {
      decisionId: parsed.decisionId,
      severity: (parsed.severity ?? "medium") as PmEscalation["severity"],
      question: parsed.question ?? "",
      options: parsed.options,
      expiresAt: parsed.expiresAt ?? "",
      notificationId: n.id,
      projectId: n.projectId,
      title: n.title,
      createdAt: n.createdAt,
      read: n.read,
    };
  } catch {
    return null;
  }
}

/**
 * Open `pm_escalation` notifications for the current user. Reuses the existing
 * `/notifications` endpoint — Epic 6 does not introduce a separate
 * escalations table.
 */
export function usePmEscalations(opts: { onlyUnread?: boolean } = {}) {
  const onlyUnread = opts.onlyUnread ?? true;
  const query = useQuery({
    queryKey: ["pm-escalations"],
    queryFn: getNotifications,
    refetchInterval: 30_000,
  });

  const escalations = useMemo<PmEscalation[]>(() => {
    const items = query.data ?? [];
    return items
      .filter((n) => (onlyUnread ? !n.read : true))
      .map(parseEscalation)
      .filter((e): e is PmEscalation => e !== null);
  }, [query.data, onlyUnread]);

  return { ...query, escalations };
}
