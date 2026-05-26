'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui';
import { DecomposeButton } from './decompose-button';
import { useToast } from '@/hooks/use-toast';
import { PIPELINE_STAGES } from '@/app/(protected)/pipeline/progress/constants';
import type { Issue, IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';
import type { IssueDetailTabKey } from './issue-detail-tabs';

export const STATUS_TAB_MAP: Record<IssueStatus, IssueDetailTabKey> = {
  open: 'overview',
  needs_info: 'overview',
  confirmed: 'overview',
  waiting: 'plan',
  approved: 'plan',
  in_progress: 'activity',
  developed: 'activity',
  deploying: 'activity',
  testing: 'activity',
  tested: 'activity',
  pass: 'activity',
  staging: 'activity',
  released: 'activity',
  closed: 'activity',
  reopen: 'activity',
  on_hold: 'activity',
  // ISS-236 — drafts open at the overview tab; the Promote/Discard CTAs live
  // in the pipeline-actions slot, not in any pipeline stage.
  draft: 'overview',
};

export interface IssueDetailHeaderProps {
  issue: Issue;
  projectSlug: string;
  onTitlePatch: (issueId: string, patch: IssuePatchInput) => void;
  onStageJump: (tab: IssueDetailTabKey) => void;
}

export function IssueDetailHeader({
  issue,
  projectSlug,
  onTitlePatch,
  onStageJump,
}: IssueDetailHeaderProps) {
  const { addToast } = useToast();
  const [watching, setWatching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target as Node)) return;
      setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const currentStatus = issue.status as IssueStatus;
  const visibleStages = PIPELINE_STAGES.filter((s) => s.key !== 'blocked');
  const currentIndex = visibleStages.findIndex((s) =>
    (s.statuses as readonly string[]).includes(currentStatus),
  );

  function toggleWatch() {
    setWatching((v) => !v);
    addToast('Watch is coming soon');
  }

  function copyLink() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setMenuOpen(false);
      return;
    }
    void navigator.clipboard.writeText(window.location.href).then(() => {
      addToast('Link copied');
    });
    setMenuOpen(false);
  }

  return (
    <header className="space-y-3">
      <div className="flex items-start gap-4">
        <span className="font-mono text-2xl tracking-widest text-primary shrink-0">
          {issue.displayId}
        </span>
        <div className="min-w-0 flex-1">
          <EditableTitle
            value={issue.title}
            onSave={(next) => onTitlePatch(issue.id, { title: next })}
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <DecomposeButton
            issueId={issue.id}
            displayId={issue.displayId ?? `ISS-${issue.issSeq ?? ''}`}
            status={currentStatus}
          />
          <Button
            size="xs"
            variant="ghost"
            onClick={toggleWatch}
            aria-pressed={watching}
          >
            {/* TODO(post-ISS-121): wire to watcher API once available */}
            {watching ? 'Watching' : 'Watch'}
          </Button>
          <div ref={menuRef} className="relative">
            <Button
              size="xs"
              variant="ghost"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More actions"
              onClick={() => setMenuOpen((o) => !o)}
            >
              ⋯
            </Button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-sm border border-outline-variant/30 bg-surface shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={copyLink}
                  className="block w-full px-3 py-2 text-left text-xs text-on-surface hover:bg-surface-container-high"
                >
                  Copy link
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    toggleWatch();
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-xs text-on-surface hover:bg-surface-container-high"
                >
                  {watching ? 'Unwatch' : 'Watch'}
                </button>
                <Link
                  href={`/projects/${projectSlug}/templates/new?fromIssue=${issue.displayId}`}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="block w-full px-3 py-2 text-left text-xs text-on-surface hover:bg-surface-container-high"
                >
                  Convert to template
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      <nav
        aria-label="Pipeline stage breadcrumb"
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]"
      >
        {visibleStages.map((stage, idx) => {
          const isCurrent = idx === currentIndex;
          const isPast = currentIndex >= 0 && idx < currentIndex;
          const tone = isCurrent
            ? 'font-bold text-primary'
            : isPast
              ? 'text-on-surface'
              : 'text-on-surface-variant';
          const firstStatus = stage.statuses[0] as IssueStatus;
          return (
            <span key={stage.key} className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onStageJump(STATUS_TAB_MAP[firstStatus])}
                aria-label={`Jump to ${stage.label} tab`}
                className={`${tone} hover:underline`}
              >
                {stage.label}
              </button>
              {idx < visibleStages.length - 1 && (
                <span className="text-outline-variant" aria-hidden="true">
                  ›
                </span>
              )}
            </span>
          );
        })}
      </nav>
    </header>
  );
}

interface EditableTitleProps {
  value: string;
  onSave: (next: string) => void;
}

function EditableTitle({ value, onSave }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    onSave(trimmed);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
            setDraft(value);
          }
        }}
        onBlur={commit}
        className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-3 py-2 text-2xl font-bold text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    );
  }

  return (
    <div className="group relative min-w-0 rounded-sm border border-transparent p-1 -m-1 hover:border-outline-variant/30 hover:bg-surface-container-low transition-colors">
      <h1 className="text-2xl font-bold text-primary truncate pr-8">{value}</h1>
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title="Edit title"
        aria-label="Edit title"
        className="absolute right-1 top-1 rounded-sm p-1.5 text-outline-variant opacity-0 hover:bg-surface-container-high hover:text-on-surface group-hover:opacity-100 transition-all border border-transparent hover:border-outline-variant/30"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}
