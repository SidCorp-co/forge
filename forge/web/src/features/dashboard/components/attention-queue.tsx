'use client';

import type { AttentionGroup } from '../hooks/use-attention-queue';
import { AttentionCard } from './attention-card';
import { FileSearch, Code, TestTube, Rocket, CheckCircle2 } from 'lucide-react';
import type { Issue } from '@/features/issue/types';

const GROUP_ICONS: Record<string, typeof FileSearch> = {
  planReview: FileSearch,
  codeReview: Code,
  qaApproval: TestTube,
  releaseApproval: Rocket,
};

interface AttentionQueueProps {
  groups: AttentionGroup[];
  slug: string;
  testingUrls?: { label: string; url: string }[];
}

export function AttentionQueue({ groups, slug, testingUrls }: AttentionQueueProps) {
  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <CheckCircle2 className="h-8 w-8 text-success mb-3" />
        <p className="text-sm font-medium text-on-surface">All clear</p>
        <p className="text-xs text-outline mt-1">No items need your attention</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const Icon = GROUP_ICONS[group.key] ?? FileSearch;
        return (
          <div key={group.key}>
            <div className="flex items-center gap-2 mb-3">
              <Icon className="h-4 w-4 text-on-surface-variant" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.15em] text-on-surface-variant">
                {group.label}
              </h3>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-on-primary">
                {group.count}
              </span>
            </div>
            <div className="space-y-2">
              {group.issues.map((issue: Issue) => (
                <AttentionCard
                  key={issue.documentId}
                  issue={issue}
                  slug={slug}
                  testingUrls={testingUrls}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
