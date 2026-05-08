'use client';

import { useState } from 'react';
import { useActivities } from '@/features/activity/hooks/use-activities';
import { activityApi } from '@/features/activity/api/activity-api';
import type { Activity } from '@/features/activity/types';
import { STATUS_COLORS, PRIORITY_COLORS } from '@/lib/constants';
import { relativeTime } from '@/lib/utils/relative-time';
import { formatStatusLabel } from '@/lib/utils/format-status';
import { Markdown } from '@/components/ui/markdown';
import { strapiMediaUrl } from '@/lib/api/client';
import { ImagePreview } from '@/components/ui/image-preview';
import { useQueryClient } from '@tanstack/react-query';

interface Props {
  issueDocumentId: string;
}

function StatusBadge({ value, type }: { value: string; type: 'status' | 'priority' }) {
  const colors = type === 'status' ? STATUS_COLORS : PRIORITY_COLORS;
  const cls = (colors as Record<string, string>)[value] || 'bg-surface-container-high text-tertiary border-outline-variant/30';
  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${cls}`}>
      {formatStatusLabel(value)}
    </span>
  );
}

const ICONS: Record<string, string> = {
  created: '\u{1F7E2}',
  comment: '\u{1F4AC}',
  status_change: '\u{1F504}',
  priority_change: '\u2B06\uFE0F',
  category_change: '\u{1F4C1}',
  complexity_change: '\u{1F4D0}',
  title_change: '\u270F\uFE0F',
  edited: '\u270F\uFE0F',
  assignee_change: '\u{1F464}',
  manual_hold_set: '\u{1F512}',
  manual_hold_cleared: '\u{1F513}',
  label_added: '\u{1F3F7}\uFE0F',
  label_removed: '\u{1F3F7}\uFE0F',
  enriched: '\u2728',
  agent_session: '\u{1F916}',
  relation_added: '\u{1F517}',
  relation_removed: '\u{1F517}',
  pikachu_decision: '\u26A1',
};

const EVENT_DESCRIPTIONS: Record<string, string> = {
  status_change: 'changed status',
  priority_change: 'changed priority',
  category_change: 'changed category',
  complexity_change: 'changed complexity',
  title_change: 'changed the title',
  edited: 'edited',
  assignee_change: 'changed assignee',
  manual_hold_set: 'put issue on manual hold',
  manual_hold_cleared: 'released manual hold',
  label_added: 'added label',
  label_removed: 'removed label',
  enriched: 'enriched this issue with AI',
  agent_session: 'started an agent session',
  relation_added: 'added a relation',
  relation_removed: 'removed a relation',
};

const DELETABLE_TYPES = new Set([
  'comment',
  'status_change', 'priority_change', 'category_change', 'complexity_change',
  'title_change', 'edited', 'assignee_change',
  'manual_hold_set', 'manual_hold_cleared',
  'label_added', 'label_removed',
  'enriched', 'agent_session', 'relation_added', 'relation_removed',
]);

/** Shared timeline row wrapper */
function TimelineRow({ icon, ringColor, children }: { icon: string; ringColor?: string; children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden pl-8 pb-8">
      <div className="absolute left-3 top-0 bottom-0 w-px bg-outline-variant/30" />
      <div className={`absolute left-0 top-1 flex h-6 w-6 items-center justify-center rounded-sm bg-surface-container-low text-sm border ${ringColor || 'border-outline-variant/50'}`}>
        {icon}
      </div>
      {children}
    </div>
  );
}

/** Pikachu decision card with approve/reject eval buttons */
function PikachuDecisionItem({ activity, issueDocumentId }: { activity: Activity; issueDocumentId: string }) {
  const queryClient = useQueryClient();
  const time = relativeTime(activity.createdAt);
  const meta = (activity.metadata || {}) as Record<string, any>;
  const decision = meta.decision || {};
  const pipeline = meta.pipeline || {};
  const evalResult = meta.eval as { verdict: string; note?: string; at: string } | null;
  const [submitting, setSubmitting] = useState(false);

  const agreed = pipeline.agreed;
  const ringColor = evalResult
    ? evalResult.verdict === 'approve' ? 'border-success/50' : 'border-danger/50'
    : agreed ? 'border-warning/50' : 'border-warning-dim/50';

  async function handleEval(verdict: 'approve' | 'reject') {
    setSubmitting(true);
    try {
      await activityApi.evaluate(issueDocumentId, activity.documentId, verdict);
      queryClient.invalidateQueries({ queryKey: ['activities', issueDocumentId] });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <TimelineRow icon={ICONS.pikachu_decision} ringColor={ringColor}>
      <div className="min-w-0 overflow-hidden rounded-sm border border-warning-dim/30 bg-warning-dim/5 p-4 shadow-sm">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-outline">
          <span className="font-bold text-tertiary">Pikachu</span>
          <span className="rounded-sm border border-warning/30 bg-warning-dim/10 px-2 flex items-center h-5 text-[10px] uppercase font-bold tracking-widest text-warning">Shadow Decision</span>
          <span className="font-mono text-[10px]">{time.toUpperCase()}</span>
        </div>

        {/* Decision table */}
        <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div className="text-[10px] uppercase tracking-widest text-outline font-bold">Action</div>
          <div className="font-mono text-on-surface-variant text-xs uppercase tracking-widest">{decision.action}</div>
          {decision.skill && (
            <>
              <div className="text-[10px] uppercase tracking-widest text-outline font-bold">Skill</div>
              <div className="font-mono text-on-surface-variant text-xs uppercase tracking-widest">{decision.skill}</div>
            </>
          )}
          <div className="text-[10px] uppercase tracking-widest text-outline font-bold">Priority</div>
          <div className="text-on-surface-variant text-xs uppercase tracking-widest font-mono">{decision.priority}</div>
          <div className="text-[10px] uppercase tracking-widest text-outline font-bold">Pipeline ran</div>
          <div className="font-mono text-on-surface-variant text-xs uppercase tracking-widest">{pipeline.actualSkill}</div>
          <div className="text-[10px] uppercase tracking-widest text-outline font-bold">Agreed</div>
          <div className={agreed ? 'text-success font-bold uppercase text-[10px] tracking-widest' : 'font-bold text-danger uppercase text-[10px] tracking-widest'}>
            {agreed ? 'Yes' : 'No'}
          </div>
        </div>

        {/* Reasoning */}
        <div className="mb-3 text-sm text-on-surface-variant">
          <span className="text-[10px] font-bold uppercase tracking-widest text-warning block mb-1">Reasoning</span>
          <Markdown className="prose prose-invert max-w-none text-sm">{activity.body || ''}</Markdown>
        </div>

        {decision.guidance && (
          <div className="mb-3 text-sm text-on-surface-variant border-t border-warning-dim/20 pt-3">
            <span className="text-[10px] font-bold uppercase tracking-widest text-warning block mb-1">Guidance</span>
            <Markdown className="prose prose-invert max-w-none text-sm">{decision.guidance}</Markdown>
          </div>
        )}

        {decision.revisionFeedback && (
          <div className="mb-3 text-sm text-on-surface-variant border-t border-warning-dim/20 pt-3">
            <span className="text-[10px] font-bold uppercase tracking-widest text-warning block mb-1">Revision feedback</span>
            <Markdown className="prose prose-invert max-w-none text-sm">{decision.revisionFeedback}</Markdown>
          </div>
        )}

        {/* Status badge row */}
        {activity.fromValue && activity.toValue && (
          <div className="mb-4 flex items-center gap-2 border-t border-warning-dim/20 pt-3 mt-3">
            <StatusBadge value={activity.fromValue} type="status" />
            <span className="text-outline-variant">&rarr;</span>
            <StatusBadge value={activity.toValue} type="status" />
          </div>
        )}

        {/* Eval buttons or result */}
        {evalResult ? (
          <div className={`mt-2 rounded-sm border px-3 py-1.5 flex items-center text-[10px] font-bold uppercase tracking-widest ${
            evalResult.verdict === 'approve'
              ? 'bg-success-surface border-success/20 text-success'
              : 'bg-danger-surface border-danger/20 text-danger'
          }`}>
            {evalResult.verdict === 'approve' ? 'APPROVED' : 'REJECTED'}
            {evalResult.note && <span className="ml-2 font-mono text-outline">— {evalResult.note}</span>}
          </div>
        ) : (
          <div className="mt-4 flex gap-3">
            <button
              disabled={submitting}
              onClick={() => handleEval('approve')}
              className="rounded-sm border border-success/30 bg-success-surface px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-success hover:bg-success hover:text-success-surface disabled:opacity-50 transition-all font-mono"
            >
              APPROVE
            </button>
            <button
              disabled={submitting}
              onClick={() => handleEval('reject')}
              className="rounded-sm border border-danger/30 bg-danger-surface px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-danger hover:bg-danger hover:text-danger-surface disabled:opacity-50 transition-all font-mono"
            >
              REJECT
            </button>
          </div>
        )}
      </div>
    </TimelineRow>
  );
}

function DeleteButton({ activity, issueDocumentId }: { activity: Activity; issueDocumentId: string }) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);

  if (!DELETABLE_TYPES.has(activity.type)) return null;

  return (
    <button
      disabled={deleting}
      onClick={async () => {
        setDeleting(true);
        try {
          await activityApi.delete(issueDocumentId, activity.documentId);
          queryClient.invalidateQueries({ queryKey: ['activities', issueDocumentId] });
        } finally {
          setDeleting(false);
        }
      }}
      className="ml-auto opacity-0 group-hover:opacity-100 text-outline-variant hover:text-danger transition-opacity text-xs px-1"
      title="Delete activity"
    >
      &times;
    </button>
  );
}

function ActivityItem({ activity, issueDocumentId }: { activity: Activity; issueDocumentId: string }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const icon = ICONS[activity.type] || '\u2022';
  const time = relativeTime(activity.createdAt);
  const actor = activity.actor || 'system';

  // Pikachu decision — custom card with eval
  if (activity.type === 'pikachu_decision') {
    return <PikachuDecisionItem activity={activity} issueDocumentId={issueDocumentId} />;
  }

  // Comment — full body card
  if (activity.type === 'comment') {
    const meta = (activity.metadata || {}) as Record<string, any>;
    const attachments = (meta.attachments || []) as { id: number; url: string; name: string; mime: string }[];
    const imageGallery = attachments.filter((a) => /^image\//.test(a.mime)).map((a) => ({ url: strapiMediaUrl(a.url), name: a.name }));
    return (
      <TimelineRow icon={icon} ringColor={activity.isAI ? "border-info-dim/50" : "border-outline-variant/50"}>
        <div className={`group min-w-0 overflow-hidden rounded-sm border p-4 shadow-sm ${activity.isAI ? 'border-info-dim/30 bg-info-surface/20' : 'border-outline-variant/30 bg-surface'}`}>
          <div className="mb-2 flex items-center gap-2 text-xs text-outline">
            <span className="font-bold text-primary">{actor}</span>
            {activity.isAI && <span className="rounded-sm border border-info-dim/30 bg-info-surface px-2 h-5 flex items-center text-[10px] font-bold uppercase tracking-widest text-info">AI</span>}
            <span className="font-mono text-[10px] uppercase">commented {time}</span>
            <DeleteButton activity={activity} issueDocumentId={issueDocumentId} />
          </div>
          <Markdown className={`text-sm ${activity.isAI ? "text-tertiary" : "text-on-surface-variant"} prose prose-invert max-w-none`}>{activity.body ?? ''}</Markdown>
          {attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 pt-3 border-t border-outline-variant/30">
              {attachments.map((a) => {
                const isImage = /^image\//.test(a.mime);
                const fullUrl = strapiMediaUrl(a.url);
                return isImage ? (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setPreviewIndex(imageGallery.findIndex((img) => img.url === fullUrl))}
                    className="flex flex-col gap-1.5 rounded-sm border border-outline-variant/50 bg-surface-container-low p-1.5 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-zoom-in"
                  >
                    <img src={fullUrl} alt={a.name} className="h-20 w-32 rounded-sm object-cover" />
                    <span className="max-w-[128px] truncate font-mono text-[10px] px-1 pb-0.5">{a.name}</span>
                  </button>
                ) : (
                  <a
                    key={a.id}
                    href={fullUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-[10px] font-mono text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors uppercase tracking-wider"
                  >
                    <span className="max-w-[100px] truncate">{a.name}</span>
                  </a>
                );
              })}
            </div>
          )}
          {previewIndex !== null && (
            <ImagePreview images={imageGallery} initialIndex={previewIndex} onClose={() => setPreviewIndex(null)} />
          )}
        </div>
      </TimelineRow>
    );
  }

  // Created — simple one-liner
  if (activity.type === 'created') {
    return (
      <TimelineRow icon={icon} ringColor="border-success/50">
        <div className="flex items-center gap-2 pt-1 text-sm text-on-surface-variant">
          <span className="font-bold text-primary">{actor}</span>
          <span>opened this issue</span>
          <span className="text-[10px] font-mono text-outline uppercase">{time}</span>
        </div>
      </TimelineRow>
    );
  }

  // Status/priority change — colored badges for from→to
  if (activity.type === 'status_change' || activity.type === 'priority_change') {
    const badgeType = activity.type === 'status_change' ? 'status' : 'priority';
    const desc = EVENT_DESCRIPTIONS[activity.type];
    return (
      <TimelineRow icon={icon}>
        <div className="group flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm text-on-surface-variant">
          <span className="font-bold text-primary">{actor}</span>
          <span>{desc}</span>
          {activity.fromValue && <StatusBadge value={activity.fromValue} type={badgeType} />}
          <span className="text-outline-variant">&rarr;</span>
          {activity.toValue && <StatusBadge value={activity.toValue} type={badgeType} />}
          <span className="text-[10px] font-mono text-outline uppercase ml-1">{time}</span>
          <DeleteButton activity={activity} issueDocumentId={issueDocumentId} />
        </div>
      </TimelineRow>
    );
  }

  // Generic event — inline with optional from→to values
  return (
    <TimelineRow icon={icon}>
      <div className="group flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm text-on-surface-variant">
        <span className="font-bold text-primary">{actor}</span>
        <span>{EVENT_DESCRIPTIONS[activity.type] || formatStatusLabel(activity.type)}</span>
        {activity.fromValue && <span className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-2 py-0.5 text-[10px] font-mono uppercase text-tertiary">{activity.fromValue}</span>}
        {activity.fromValue && activity.toValue && <span className="text-outline-variant">&rarr;</span>}
        {activity.toValue && <span className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-2 py-0.5 text-[10px] font-mono uppercase text-tertiary">{activity.toValue}</span>}
        <span className="text-[10px] font-mono text-outline uppercase ml-1">{time}</span>
        <DeleteButton activity={activity} issueDocumentId={issueDocumentId} />
      </div>
    </TimelineRow>
  );
}

export function IssueTimeline({ issueDocumentId }: Props) {
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useActivities(issueDocumentId);
  const activities = data?.pages.flatMap((p) => p.items) ?? [];

  if (isLoading) {
    return (
      <div className="py-8 text-center text-[10px] font-mono uppercase tracking-widest text-outline-variant">
        Loading activity…
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="py-8 text-center text-[10px] font-mono uppercase tracking-widest text-outline-variant">
        No activity yet.
      </div>
    );
  }

  return (
    <div className="mt-8 overflow-x-hidden pt-2">
      {activities.map((activity) => (
        <ActivityItem key={activity.documentId} activity={activity} issueDocumentId={issueDocumentId} />
      ))}
      {hasNextPage && (
        <div className="pl-8 pb-4">
          <button
            type="button"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
            className="rounded-sm border border-outline-variant/40 bg-surface-container-low px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50 transition-colors font-mono"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
