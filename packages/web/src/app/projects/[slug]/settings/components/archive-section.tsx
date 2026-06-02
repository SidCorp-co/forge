'use client';

import { useState } from 'react';
import {
  useArchiveProject,
  useProject,
  useUnarchiveProject,
} from '@/features/project/hooks/use-projects';

interface Props {
  projectId: string;
  isOwner: boolean;
}

/**
 * ISS-353 — soft archive / unarchive a project. Owner-only (the action is
 * disabled for non-owners and the server returns 403). Archiving requires
 * type-to-confirm of the project name; it hides the project from the default
 * list and pauses auto-pipeline dispatch but destroys nothing. Unarchive is a
 * single click.
 */
export function ArchiveSection({ projectId, isOwner }: Props) {
  const { data: project } = useProject(projectId);
  const archive = useArchiveProject();
  const unarchive = useUnarchiveProject();

  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const projectName = project?.name ?? '';
  const isArchived = Boolean(project?.archivedAt);
  const canConfirm = isOwner && typed.trim() === projectName && projectName.length > 0;

  const onArchive = async () => {
    setFeedback(null);
    if (!canConfirm) return;
    try {
      await archive.mutateAsync(projectId);
      setConfirming(false);
      setTyped('');
      setFeedback('Project archived. It no longer appears in the default list.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to archive project.');
    }
  };

  const onUnarchive = async () => {
    setFeedback(null);
    if (!isOwner) return;
    try {
      await unarchive.mutateAsync(projectId);
      setFeedback('Project unarchived. It is active again.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to unarchive project.');
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <div className="flex items-center gap-3">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
            Archive
          </h2>
          {!isOwner && (
            <span className="rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-outline">
              Owner only
            </span>
          )}
        </div>
        <span className="text-[9px] font-mono text-outline">DNG_ARC</span>
      </div>

      <div className="bg-surface-container-low border border-error/30 p-8 space-y-5">
        {isArchived ? (
          <>
            <div>
              <p className="text-sm font-medium text-on-surface">This project is archived</p>
              <p className="mt-1 text-xs text-outline">
                It is hidden from the default project list and no new pipeline jobs are
                dispatched. All issues, comments, runs, and sessions are retained. Unarchive to
                make it active again.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onUnarchive()}
              disabled={!isOwner || unarchive.isPending}
              className="bg-primary text-on-primary px-6 py-2 text-[10px] font-bold uppercase tracking-[0.15em] rounded-sm hover:opacity-90 disabled:opacity-50"
            >
              {unarchive.isPending ? 'Unarchiving…' : 'Unarchive project'}
            </button>
          </>
        ) : (
          <>
            <div>
              <p className="text-sm font-medium text-on-surface">Archive this project</p>
              <p className="mt-1 text-xs text-outline">
                Archiving hides the project from the default list and pauses auto-pipeline
                dispatch. Nothing is deleted — issues, comments, runs, and sessions are kept and
                you can unarchive at any time.
              </p>
            </div>

            {!confirming ? (
              <button
                type="button"
                onClick={() => {
                  setConfirming(true);
                  setFeedback(null);
                }}
                disabled={!isOwner}
                className="border border-error/50 text-error px-6 py-2 text-[10px] font-bold uppercase tracking-[0.15em] rounded-sm hover:bg-error/10 disabled:opacity-50"
              >
                Archive project
              </button>
            ) : (
              <div className="space-y-3">
                <label
                  htmlFor="archive-confirm"
                  className="block text-xs text-on-surface-variant"
                >
                  Type the project name{' '}
                  <span className="font-mono text-on-surface">{projectName}</span> to confirm:
                </label>
                <input
                  id="archive-confirm"
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={projectName}
                  disabled={!isOwner}
                  className="w-full bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-error focus:ring-0 transition-colors disabled:opacity-50"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void onArchive()}
                    disabled={!canConfirm || archive.isPending}
                    className="bg-error text-on-error px-6 py-2 text-[10px] font-bold uppercase tracking-[0.15em] rounded-sm hover:opacity-90 disabled:opacity-50"
                  >
                    {archive.isPending ? 'Archiving…' : 'Confirm archive'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false);
                      setTyped('');
                    }}
                    className="border border-outline/30 text-on-surface-variant px-6 py-2 text-[10px] font-bold uppercase tracking-[0.15em] rounded-sm hover:bg-surface-container"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {feedback && <p className="text-xs text-outline">{feedback}</p>}
      </div>
    </section>
  );
}
