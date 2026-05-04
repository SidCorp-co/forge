'use client';

import { useNotifications } from '@/features/notification/hooks/use-notifications';
import type { Notification } from '@/features/notification/types';
import { useMemo } from 'react';
import type { PmEscalationPayload } from '../types';

export interface PmEscalation extends PmEscalationPayload {
  notificationId: string;
  title: string;
  createdAt: string;
}

function parseEscalation(n: Notification): PmEscalation | null {
  if (n.type !== "pm_escalation" || !n.body) return null;
  try {
    const parsed = JSON.parse(n.body) as Partial<PmEscalationPayload>;
    if (!parsed.decisionId || !Array.isArray(parsed.options)) return null;
    return {
      decisionId: parsed.decisionId,
      severity: (parsed.severity ?? 'medium') as PmEscalation['severity'],
      question: parsed.question ?? '',
      options: parsed.options,
      expiresAt: parsed.expiresAt ?? '',
      notificationId: n.id,
      title: n.title,
      createdAt: n.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Open `pm_escalation` notifications for the current user, optionally
 * filtered to a project. Backed by the existing notifications endpoint —
 * Epic 6 does not introduce a separate escalations table.
 */
export function usePmEscalations(projectId?: string) {
  const query = useNotifications(true);
  const escalations = useMemo<PmEscalation[]>(() => {
    const items = query.data?.data ?? [];
    return items
      .filter((n) => !n.read && (!projectId || n.projectId === projectId))
      .map(parseEscalation)
      .filter((e): e is PmEscalation => e !== null);
  }, [query.data, projectId]);
  return { ...query, escalations };
}
