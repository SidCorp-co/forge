'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import ReactDiffViewer from 'react-diff-viewer-continued';
import { Skeleton } from '@/components/ui';
import { useJobPrompt } from '../hooks/use-job-prompt';

interface Props {
  /** Older run — rendered on the left of the unified diff. */
  leftJobId: string;
  /** Newer run — rendered on the right. Signed token delta is `right - left`. */
  rightJobId: string;
  onClose: () => void;
}

const signedTokens = new Intl.NumberFormat('en-US', { signDisplay: 'exceptZero' });

export function JobDiffPanel({ leftJobId, rightJobId, onClose }: Props) {
  const left = useJobPrompt(leftJobId);
  const right = useJobPrompt(rightJobId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  let body: React.ReactNode;
  if (left.isLoading || right.isLoading) {
    body = (
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (left.error || right.error) {
    body = (
      <p className="text-sm text-on-surface-variant">
        One or both runs no longer have a prompt snapshot stored.
      </p>
    );
  } else if (left.data && right.data) {
    const L = left.data;
    const R = right.data;
    const sameHash = !!L.systemPromptHash && L.systemPromptHash === R.systemPromptHash;
    const delta =
      L.actualUsage && R.actualUsage ? R.actualUsage.input - L.actualUsage.input : null;

    body = (
      <div className="space-y-6">
        <section>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            System prompt
          </h3>
          {sameHash ? (
            <span
              data-testid="system-prompt-identical"
              className="inline-block rounded bg-surface-container px-2 py-1 font-mono text-xs"
            >
              identical (hash {L.systemPromptHash!.slice(0, 8)})
            </span>
          ) : (
            <div data-testid="system-prompt-diff" className="overflow-x-auto text-xs">
              <ReactDiffViewer
                oldValue={L.systemPrompt ?? ''}
                newValue={R.systemPrompt ?? ''}
                splitView={false}
                hideLineNumbers={false}
              />
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            User prompt
          </h3>
          <div data-testid="user-prompt-diff" className="overflow-x-auto text-xs">
            <ReactDiffViewer
              oldValue={L.userPrompt ?? ''}
              newValue={R.userPrompt ?? ''}
              splitView={false}
              hideLineNumbers={false}
            />
          </div>
        </section>
        <footer
          data-testid="token-delta"
          className="border-t border-outline-variant/30 pt-3 text-xs text-on-surface"
        >
          Token delta:{' '}
          {delta === null
            ? 'n/a'
            : delta === 0
              ? '0 (unchanged)'
              : `${signedTokens.format(delta)} input tokens`}
        </footer>
      </div>
    );
  } else {
    body = <p className="text-sm text-on-surface-variant">Prompt envelope unavailable.</p>;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Compare runs"
    >
      <button
        type="button"
        aria-label="Close diff overlay"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative max-h-[90vh] w-[min(1100px,96vw)] overflow-y-auto rounded-lg border border-outline-variant/40 bg-surface p-6 shadow-2xl">
        <header className="mb-4 flex items-center justify-between border-b border-outline-variant/30 pb-3">
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-on-surface">Compare runs</h2>
            <p className="text-[11px] text-on-surface-variant">
              older &rarr; newer (left to right)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-outline-variant px-3 py-1 text-xs text-on-surface hover:bg-surface-container-low"
          >
            Close
          </button>
        </header>
        {body}
      </div>
    </div>,
    document.body,
  );
}
