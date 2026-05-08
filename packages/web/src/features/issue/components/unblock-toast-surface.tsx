'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import { useUnblockToasts } from '../hooks/use-unblock-cascade';

const NAMED_LIMIT = 3;

interface Props {
  projectSlug: string;
}

/**
 * Renders unblock-cascade toasts emitted by the backend when a blocker hits a
 * terminal status with outgoing `kind='blocks'` dependents. Toasts auto-dismiss
 * after 4s; clicking a dependent chip navigates to its issue detail.
 */
export function UnblockToastSurface({ projectSlug }: Props) {
  const { toasts, dismiss } = useUnblockToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => {
        const named = t.dependents.slice(0, NAMED_LIMIT);
        const remaining = t.dependents.length - named.length + t.overflow;
        return (
          <div
            key={t.id}
            className="animate-slide-in flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm text-on-surface shadow-lg"
          >
            <span className="font-medium">Unblocked:</span>
            <span className="flex flex-wrap items-center gap-1">
              {named.map((dep, i) => (
                <span key={dep.issueId} className="inline-flex items-center">
                  <Link
                    href={`/projects/${projectSlug}/issues/ISS-${dep.issSeq}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    ISS-{dep.issSeq}
                  </Link>
                  {i < named.length - 1 && <span className="text-on-surface-variant">,&nbsp;</span>}
                </span>
              ))}
              {remaining > 0 && (
                <span className="text-on-surface-variant">+{remaining} more</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="ml-1 rounded-sm p-0.5 text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
