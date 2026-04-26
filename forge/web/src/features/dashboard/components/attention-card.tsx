'use client';

import Link from 'next/link';
import { AlertOctagon, AtSign, Eye, MessageCircleWarning } from 'lucide-react';
import type { AttentionItem, AttentionKind } from '../types';
import { relativeTime } from '@/lib/utils/relative-time';
import { STATUS_COLORS } from '@/lib/constants';
import type { IssueStatus } from '@/features/issue/types';

const KIND_ICON: Record<AttentionKind, typeof Eye> = {
  needs_review: Eye,
  awaiting_input: MessageCircleWarning,
  mention: AtSign,
  failed_job: AlertOctagon,
};

export function AttentionCard({ item }: { item: AttentionItem }) {
  const Icon = KIND_ICON[item.kind];
  return (
    <Link
      href={item.link}
      className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-surface-container-high"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-outline" />
      {item.issueRef && (
        <span className="font-mono tracking-widest text-primary">{item.issueRef}</span>
      )}
      <span className="flex-1 truncate text-on-surface">{item.title}</span>
      {item.projectName && (
        <span className="hidden truncate text-outline sm:inline">{item.projectName}</span>
      )}
      {item.status && (
        <span
          className={`inline-flex rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
            STATUS_COLORS[item.status as IssueStatus] ?? 'bg-outline-variant text-outline'
          }`}
        >
          {item.status.replace('_', ' ')}
        </span>
      )}
      <span className="tabular-nums text-outline">{relativeTime(item.since)}</span>
    </Link>
  );
}

export default AttentionCard;
