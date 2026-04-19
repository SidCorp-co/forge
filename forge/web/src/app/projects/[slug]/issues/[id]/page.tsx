'use client';

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { useIssue, useUpdateIssue } from '@/features/issue/hooks/use-issues';
import { useProject } from '@/features/project/hooks/use-projects';
import { useCreateComment } from '@/features/comment/hooks/use-comments';
import { agentApi } from '@/features/agent/api';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { STATUS_COLORS, PRIORITY_COLORS, ALL_STATUSES, ALL_PRIORITIES, ALL_CATEGORIES, CLOSED_STATUSES, COMPLEXITY_COLORS, ALL_COMPLEXITIES } from '@/lib/constants';
import { relativeTime } from '@/lib/utils/relative-time';
import { IssueTimeline } from '@/components/issue/issue-timeline';
import { LabelBadge } from '@/components/issue/label-badge';
import { Markdown } from '@/components/ui/markdown';
import { IssueAttachments } from '@/components/issue/issue-detail-modal/issue-attachments';
import { IssueAgentSessions } from '@/components/issue/issue-detail-modal/issue-agent-sessions';
import { IssueTasks } from '@/components/issue/issue-detail-modal/issue-tasks';
import { CommentInput } from '@/components/issue/issue-detail-modal/comment-input';
import { EditableField } from '@/components/issue/issue-detail-modal/editable-field';
import { IssueRelations } from '@/components/issue/issue-relations';
import { AgentSessionPanel } from '@/components/chat/agent-session-panel';
import { ChevronDown } from 'lucide-react';

function agentStatusColor(status: string): string {
  switch (status) {
    case 'running': return 'bg-primary text-on-primary border border-on-surface/20';
    case 'completed': return 'bg-success-surface text-success border border-success/20';
    case 'failed': return 'bg-danger-surface text-danger border border-danger/20';
    default: return 'bg-surface-container-high text-on-surface-variant border border-outline-variant/30';
  }
}

function agentButtonLabel(status: string): string {
  switch (status) {
    case 'open': return 'Triage Issue';
    case 'confirmed': return 'Plan Implementation';
    case 'approved':
    case 'in_progress': return 'Start Coding';
    case 'developed': return 'Review Code';
    case 'testing': return 'Run QA Test';
    case 'reopen': return 'Fix Issue';
    default: return 'Trigger Pipeline';
  }
}

/** Inline badge with dropdown picker for status/priority/category/complexity */
function InlineBadgeSelect({ value, options, colorMap, onChange, placeholder }: {
  value: string;
  options: { value: string; label: string }[];
  colorMap?: Record<string, string>;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current = options.find((o) => o.value === value);
  const color = colorMap?.[value] ?? 'bg-surface-container-high text-on-surface-variant border border-outline-variant/30';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-0.5 text-[10px] uppercase font-bold tracking-widest transition-colors hover:ring-1 hover:ring-offset-1 hover:ring-outline-variant hover:ring-offset-surface ${color}`}
      >
        {current?.label || placeholder || value}
        <ChevronDown className="h-3 w-3 opacity-50 ml-1" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-48 overflow-y-auto rounded-sm border border-outline-variant/30 bg-surface-container-low py-1 shadow-2xl">
          {options.map((o) => {
            const optColor = colorMap?.[o.value] ?? '';
            return (
              <button
                key={o.value}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium hover:bg-surface-container-high text-on-surface transition-colors ${o.value === value ? 'bg-surface-variant' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                {optColor && <span className={`inline-block h-2 w-2 rounded-sm ${optColor.replace(/text-\S+/g, '')}`} />}
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function IssueDetailPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const router = useRouter();
  const { data, isLoading, refetch } = useIssue(id);
  const issue = data?.data;
  const updateIssue = useUpdateIssue();
  const issueDocId = issue?.documentId ?? '';
  const createComment = useCreateComment(issueDocId);
  const { desktopConnected } = useAgentStreamContext();
  const { data: projectData } = useProject(slug);
  const project = projectData?.data;
  const [viewSessionId, setViewSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [triggeringPipeline, setTriggeringPipeline] = useState(false);

  if (isLoading) {
    return <div className="p-8 text-center text-xs font-mono text-outline-variant">LOADING ISSUE_DATA...</div>;
  }

  if (!issue) {
    return (
      <div className="p-8 text-center bg-surface text-on-surface">
        <p className="text-[10px] uppercase tracking-widest text-danger mb-2 font-bold">Error: Resource Not Found</p>
        <Link href={`/projects/${slug}/issues`} className="text-xs uppercase hover:underline text-on-surface-variant">
          &larr; Return to sequence
        </Link>
      </div>
    );
  }

  const handleUpdate = (data: Record<string, unknown>) => {
    updateIssue.mutate({ id: issue.documentId, data });
  };

  const issueNumber = `ISS-${String(issue.id).substring(0, 4)}`;
  const isOpen = !CLOSED_STATUSES.includes(issue.status);

  const issueContentProps = {
    issue, issueNumber, isOpen, slug, editingTitle, setEditingTitle,
    titleDraft, setTitleDraft, handleUpdate, desktopConnected,
    router, createComment, triggeringPipeline, setTriggeringPipeline,
    refetch,
    onSelectSession: (docId: string) => setViewSessionId(docId),
    onOpenSession: (docId: string) => setViewSessionId(docId),
  };

  if (!viewSessionId) {
    return <div className="bg-background min-h-full"><IssueContent {...issueContentProps} /></div>;
  }

  return (
    <div className="flex overflow-x-hidden min-h-[100dvh] bg-background">
      <div className="hidden lg:block lg:w-1/2 shrink-0 p-0 sm:p-0">
        <IssueContent {...issueContentProps} />
      </div>
      <div className="w-full lg:w-1/2 shrink-0 sticky top-0 self-start h-[100dvh] border-l border-outline-variant/30 bg-surface">
        <AgentSessionPanel
          sessionId={viewSessionId}
          projectSlug={slug}
          onClose={() => setViewSessionId(null)}
          onOpenFull={() => {
            router.push(`/projects/${slug}/agent?session=${viewSessionId}`);
            setViewSessionId(null);
          }}
        />
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function IssueContent({ issue, issueNumber, isOpen, slug, editingTitle, setEditingTitle, titleDraft, setTitleDraft, handleUpdate, desktopConnected, router, createComment, triggeringPipeline, setTriggeringPipeline, previewDeploy, refetch, onSelectSession, onOpenSession }: any) {
  return (
    <div className="w-full mx-auto max-w-4xl px-4 py-8 sm:px-8 font-['Inter'] antialiased">
      {/* Breadcrumb */}
      <div className="sticky top-0 z-40 -mx-4 mb-8 flex items-center gap-2 border-b border-outline-variant/30 bg-background/95 px-4 pb-4 pt-2 text-[10px] uppercase tracking-widest text-outline backdrop-blur sm:-mx-8 sm:px-8">
        <Link href={`/projects/${slug}/issues`} className="hover:text-on-surface transition-colors">
          Issues
        </Link>
        <span className="text-outline-variant">/</span>
        <span className="font-mono text-primary tracking-widest">{issueNumber}</span>

        {/* Actions in breadcrumb bar */}
        <div className="ml-auto flex items-center gap-3">
          {desktopConnected && ['open', 'confirmed', 'approved', 'in_progress', 'developed', 'testing', 'reopen'].includes(issue.status) && (
            <button
              className="rounded-sm bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:bg-tertiary active:scale-95 transition-all disabled:opacity-50 disabled:active:scale-100"
              disabled={triggeringPipeline}
              onClick={async () => {
                setTriggeringPipeline(true);
                try {
                  const res = await agentApi.triggerPipeline(issue.documentId);
                  const sid = res.data.sessionDocumentId;
                  if (sid) onOpenSession(sid);
                } catch (err: any) {
                  let msg = 'Pipeline trigger failed';
                  try { msg = JSON.parse(err.message)?.error || err.message; } catch { msg = err.message || msg; }
                  alert(msg);
                } finally {
                  setTriggeringPipeline(false);
                }
              }}
            >
              {triggeringPipeline ? 'INITIALIZING...' : agentButtonLabel(issue.status)}
            </button>
          )}
        </div>
      </div>

      {/* Title */}
      <div className="mb-8">
        {editingTitle ? (
          <div className="flex items-center gap-2">
            <input
              className="flex-1 rounded-sm border border-outline-variant/50 bg-surface-container-low px-3 py-2 text-xl font-bold text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
              value={titleDraft}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitleDraft(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter') {
                  handleUpdate({ title: titleDraft });
                  setEditingTitle(false);
                }
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              autoFocus
            />
            <button
              className="rounded-sm bg-success-surface border border-success/20 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-success hover:bg-success hover:text-success-surface transition-all"
              onClick={() => { handleUpdate({ title: titleDraft }); setEditingTitle(false); }}
            >Save</button>
            <button
              className="rounded-sm bg-surface-container-low border border-outline-variant/30 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all"
              onClick={() => setEditingTitle(false)}
            >Cancel</button>
          </div>
        ) : (
          <h1
            className="cursor-pointer text-2xl font-bold text-primary hover:text-tertiary transition-colors"
            onClick={() => { setTitleDraft(issue.title); setEditingTitle(true); }}
          >
            {issue.title}
          </h1>
        )}
      </div>

      {/* Inline metadata bar — replaces sidebar */}
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center rounded-sm px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${isOpen ? 'bg-success-surface text-success border-success/20' : 'bg-surface-container-high text-on-surface-variant border-outline-variant/30'}`}>
          {isOpen ? 'Open' : 'Closed'}
        </span>

        <InlineBadgeSelect
          value={issue.status}
          options={ALL_STATUSES}
          colorMap={STATUS_COLORS}
          onChange={(v) => handleUpdate({ status: v })}
        />
        <InlineBadgeSelect
          value={issue.priority}
          options={ALL_PRIORITIES}
          colorMap={PRIORITY_COLORS}
          onChange={(v) => handleUpdate({ priority: v })}
        />
        <InlineBadgeSelect
          value={issue.category || ''}
          options={[{ value: '', label: 'No Category' }, ...ALL_CATEGORIES]}
          onChange={(v) => handleUpdate({ category: v || null })}
          placeholder="Category"
        />
        {issue.complexity && (
          <InlineBadgeSelect
            value={issue.complexity}
            options={ALL_COMPLEXITIES}
            colorMap={COMPLEXITY_COLORS}
            onChange={(v) => handleUpdate({ complexity: v })}
          />
        )}

        {issue.agentStatus && (
          <span className={`inline-flex items-center rounded-sm px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${agentStatusColor(issue.agentStatus)}`}>
            Agent: {issue.agentStatus}
          </span>
        )}

        <button
          onClick={() => handleUpdate({ manualHold: !issue.manualHold })}
          className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest border transition-all ${
            issue.manualHold
              ? 'bg-warning-surface text-warning border-warning/30 hover:bg-warning hover:text-warning-surface'
              : 'bg-surface-container-high text-outline border-outline-variant/30 hover:bg-surface-container-highest hover:text-on-surface'
          }`}
          title={issue.manualHold ? 'Pipeline paused — click to resume' : 'Click to pause pipeline for this issue'}
        >
          {issue.manualHold ? 'PIPELINE PAUSED' : 'AUTO'}
        </button>

        {issue.reportedBy && (
          <span className="text-[10px] font-mono text-outline ml-auto">
            BY <span className="font-bold text-on-surface-variant">{issue.reportedBy}</span> / {relativeTime(issue.createdAt).toUpperCase()}
          </span>
        )}
      </div>

      {/* Labels + Relations + Preview — inline row */}
      <div className="mb-10 space-y-4">
        {issue.labels && issue.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-outline-variant mr-1">Labels</span>
            {issue.labels.map((l: any) => (
              <LabelBadge key={l.id} name={l.name} color={l.color} size="sm" />
            ))}
          </div>
        )}

        <IssueRelations
          relations={issue.relations ?? []}
          issueDocumentId={issue.documentId}
          projectSlug={slug}
          onUpdate={(relations: any) => handleUpdate({ relations })}
        />

      </div>

      {/* Monolithic Information Chunks */}
      
      {/* Description */}
      <div className="mb-8 min-w-0 overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
        <div className="bg-surface-container-low px-4 py-2 border-b border-outline-variant/20">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Description</h3>
        </div>
        <div className="p-5">
          <EditableField
            value={issue.description}
            placeholder="No description provided"
            title="Edit description"
            rows={6}
            onSave={(v: string) => handleUpdate({ description: v })}
          />
        </div>
      </div>

      {/* Acceptance Criteria */}
      <div className="mb-8 min-w-0 overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
        <div className="bg-surface-container-low px-4 py-2 border-b border-outline-variant/20">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Acceptance Criteria</h3>
        </div>
        <div className="p-5">
          <EditableField
            value={issue.acceptanceCriteria}
            placeholder="Not defined yet"
            title="Edit acceptance criteria"
            onSave={(v: string) => handleUpdate({ acceptanceCriteria: v })}
          />
        </div>
      </div>

      {/* Suggested Solution */}
      <div className="mb-8 min-w-0 overflow-hidden rounded-sm border border-outline-variant/20 bg-surface">
        <div className="bg-surface-container-low px-4 py-2 border-b border-outline-variant/20">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Suggested Solution</h3>
        </div>
        <div className="p-5">
          <EditableField
            value={issue.suggestedSolution}
            placeholder="Not defined yet"
            title="Edit suggested solution"
            onSave={(v: string) => handleUpdate({ suggestedSolution: v })}
          />
        </div>
      </div>

      {/* Plan */}
      {issue.plan && (
        <div className="mb-8 overflow-hidden rounded-sm border border-info-dim/20 bg-info-surface-lowest/20">
          <div className="bg-info-surface/30 px-4 py-2 border-b border-info-dim/20">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-info">Implementation Plan</h3>
          </div>
          <div className="p-5">
            <Markdown className="text-sm text-tertiary prose prose-invert max-w-none">{issue.plan}</Markdown>
          </div>
        </div>
      )}

      {/* AI Analysis */}
      {issue.aiSummary && (
        <div className="mb-8 overflow-hidden rounded-sm border border-warning-dim/20 bg-warning-dim/5">
          <div className="bg-warning-dim/10 px-4 py-2 border-b border-warning-dim/20">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-warning">AI Analysis</h3>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <span className="text-[10px] uppercase tracking-widest font-bold text-warning/70 mb-2 block">Summary</span>
              <Markdown className="text-sm text-tertiary prose prose-invert max-w-none">{issue.aiSummary}</Markdown>
            </div>
            {issue.aiSuggestedSolution && (
              <div className="pt-4 border-t border-warning-dim/20">
                <span className="text-[10px] uppercase tracking-widest font-bold text-warning/70 mb-2 block">AI-Suggested Solution</span>
                <Markdown className="text-sm text-tertiary prose prose-invert max-w-none">{issue.aiSuggestedSolution}</Markdown>
              </div>
            )}
            {issue.aiAcceptanceCriteria && issue.aiAcceptanceCriteria.length > 0 && (
              <div className="pt-4 border-t border-warning-dim/20">
                <span className="text-[10px] uppercase tracking-widest font-bold text-warning/70 mb-2 block">AI-Suggested Criteria</span>
                <ul className="mt-1 list-inside list-disc text-sm text-tertiary space-y-1">
                  {issue.aiAcceptanceCriteria.map((c: string, i: number) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
            {issue.aiConfidence != null && (
              <p className="pt-2 text-[10px] font-mono text-warning/50">CONFIDENCE: {Math.round(issue.aiConfidence * 100)}%</p>
            )}
          </div>
        </div>
      )}

      {/* Tasks Grid Block */}
      {issue.tasks && issue.tasks.length > 0 && (
        <div className="mb-8 overflow-hidden rounded-sm border border-outline-variant/30 bg-surface">
          <div className="bg-surface-container-low px-4 py-2 border-b border-outline-variant/30 flex justify-between items-center">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Child Tasks</h3>
            <span className="text-[10px] font-mono text-outline">{issue.tasks.length} TASK(S)</span>
          </div>
          <div className="p-0">
            <IssueTasks tasks={issue.tasks} />
          </div>
        </div>
      )}

      {/* Agent Sessions Block */}
      {issue.agentSessions && issue.agentSessions.length > 0 && (
        <div className="mb-8 overflow-hidden rounded-sm border border-outline-variant/30 bg-surface">
          <div className="bg-surface-container-low px-4 py-2 border-b border-outline-variant/30 flex justify-between items-center">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">Agent Transcripts</h3>
            <span className="text-[10px] font-mono text-outline">LOGS: {issue.agentSessions.length}</span>
          </div>
          <div className="p-0">
            <IssueAgentSessions
              sessions={issue.agentSessions}
              onSelect={onSelectSession}
              onRefresh={refetch}
            />
          </div>
        </div>
      )}

      {/* Attachments */}
      <div className="mb-8 overflow-hidden rounded-sm border border-outline-variant/30 bg-surface">
        <div className="bg-surface-container-low px-4 py-2 border-b border-outline-variant/30">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">System Artifacts</h3>
        </div>
        <div className="p-4">
          <IssueAttachments
            attachments={issue.attachments ?? []}
            issueDocumentId={issue.documentId}
            onUpdate={(_id: string, data: any) => handleUpdate(data)}
          />
        </div>
      </div>

      {/* Activity Timeline */}
      <div className="mb-8 overflow-x-hidden pt-4 border-t-2 border-surface-container-low">
        <h3 className="mb-6 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">Event Log</h3>
        <CommentInput
          onAddComment={(body: string, attachments?: number[]) =>
            createComment.mutate({ body, issue: issue.documentId, attachments })
          }
        />
        <div className="mt-8">
          <IssueTimeline issueDocumentId={issue.documentId} />
        </div>
      </div>
    </div>
  );
}
