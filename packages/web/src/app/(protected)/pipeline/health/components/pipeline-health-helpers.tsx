'use client';

import type { ReactNode } from 'react';

export interface PipelineHealthData {
  window: string;
  sessions: {
    total: number;
    completed: number;
    completedByVerification: number;
    failed: number;
    queued: number;
    running: number;
  };
  recovery: {
    recovered: number;
    recoveredBy: Record<string, number>;
    failedAfterCheck: number;
    autoRetries: number;
    retriesExhausted: number;
  };
  bySkill: Record<string, { completed: number; recovered: number; failed: number }>;
  staleWatcher: {
    runs: number;
    sessionsRecovered: number;
    sessionsFailed: number;
    lastRun: string | null;
  };
  stuck: {
    staleSessions: Array<{ id: string; title: string; updatedAt: string }>;
    orphanedInProgress: Array<{ issueId: number; documentId: string; updatedAt: string }>;
    queuedOverOneHour: Array<{ id: string; title: string; createdAt: string }>;
    failedNoRetry: number;
  };
  inProgressStuck: number;
  byProject: Record<string, {
    name: string;
    slug: string;
    pipelineEnabled: boolean;
    enabledSteps: string[];
    disabledSteps: string[];
    sessionsInWindow: number;
    missedTriggers: Array<{
      issueId: number;
      documentId: string;
      title: string;
      status: string;
      expectedSkill: string;
      updatedAt: string;
    }>;
  }>;
  desktopDevices?: Array<{
    name: string;
    deviceId: string;
    status: 'online' | 'offline';
    lastSeen: string | null;
  }>;
}

export interface RecoveryEvent {
  sessionId: string;
  issueId: number | null;
  skill: string;
  outcome: 'recovered' | 'failed';
  tag: string;
  error: string;
  timestamp: string;
}

export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return '—';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function StatCard({ label, value, icon: Icon, color = 'text-on-surface' }: {
  label: string;
  value: number | string;
  icon: any;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-surface-container p-3">
      <Icon className={`h-5 w-5 ${color}`} />
      <div>
        <div className={`text-lg font-bold ${color}`}>{value}</div>
        <div className="text-xs text-on-surface-variant">{label}</div>
      </div>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-outline-variant bg-surface-container p-4 ${className}`}>
      {children}
    </div>
  );
}
