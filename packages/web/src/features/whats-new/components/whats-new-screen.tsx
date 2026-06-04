'use client';

import { useEffect } from 'react';
import { ExternalLink, RotateCw } from 'lucide-react';
import { Markdown } from '@/components/ui/markdown';
import { RELEASES_PAGE_URL } from '@/lib/github-releases';
import { useWhatsNewStatus } from '../hooks';

/** What's New — Forge's product release feed (CHANGELOG by version, newest
 *  first, `[Unreleased]` pinned on top). Opening the page clears the nav badge
 *  by recording the current top entry as the user's last-seen marker. */
export function WhatsNewScreen() {
  const { data, isLoading, isError, refetch, markSeen, topId } = useWhatsNewStatus();

  // Mark the feed seen once it has loaded. Keyed on the top entry id so a later
  // release (or changed [Unreleased]) re-marks correctly on the next visit.
  useEffect(() => {
    if (topId) void markSeen();
    // markSeen is a fresh closure each render; topId is the stable trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topId]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-on-surface">What&apos;s New</h1>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            Forge release notes — newest first.{' '}
            <a
              href={RELEASES_PAGE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              All releases <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <div className="h-32 animate-pulse rounded-md bg-surface-container-low" />
          <div className="h-24 animate-pulse rounded-md bg-surface-container-low" />
        </div>
      ) : isError ? (
        <div className="rounded-md border border-outline-variant/30 bg-surface-container-low p-8 text-center">
          <p className="text-sm text-on-surface-variant">
            Couldn&apos;t reach the Forge changelog. Check your connection and try again.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-4 inline-flex items-center gap-2 rounded-sm bg-primary px-4 py-2 text-xs font-semibold text-on-primary transition-colors hover:bg-tertiary"
          >
            <RotateCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : !data || data.length === 0 ? (
        <div className="rounded-md border border-outline-variant/30 bg-surface-container-low p-8 text-center">
          <p className="text-sm text-on-surface-variant">No release notes are available right now.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.map((rel) => (
            <section
              key={rel.id}
              className="rounded-md border border-outline-variant/30 bg-surface-container-low p-4 md:p-5"
            >
              <div className="mb-3 flex items-center gap-2.5">
                {rel.isUnreleased ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-primary">
                    Unreleased
                  </span>
                ) : (
                  <span className="font-mono text-base font-bold text-on-surface">{rel.version}</span>
                )}
                {rel.date && <span className="text-xs text-outline">{rel.date}</span>}
              </div>
              {rel.sections.length === 0 ? (
                <p className="text-sm text-outline">No notes for this release.</p>
              ) : (
                <div className="space-y-3">
                  {rel.sections.map((s) => (
                    <div key={s.title}>
                      <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-on-surface-variant/60">
                        {s.title}
                      </p>
                      <Markdown>{s.body}</Markdown>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
