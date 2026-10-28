import { PageTitle } from "@/design/primitives/heading";
import { IconButton } from "@/design/primitives/icon-button";
import { forwardRef, type ReactNode } from "react";
import { couldNotReadAll } from "@/lib/api/read-failed";
import { offersRetryFor, RetryButton } from "@/design/primitives/retry-button";

/**
 * The issue page's sticky bar, opaque so nothing scrolls through it. Failed reads are said on one
 * line of their own under the title and actions: in the toolbar or the chips they moved the title (ISS-1228).
 */
export const IssueStickyHeader = forwardRef<
  HTMLDivElement,
  { onBack: () => void; chips: ReactNode; title: string; actions: ReactNode; failure?: ReactNode }
>(function IssueStickyHeader({ onBack, chips, title, actions, failure }, ref) {
  return (
    <div ref={ref} className="sticky top-0 z-20 -mx-4 mb-5 flex flex-wrap items-start gap-3 border-b border-line bg-app px-4 py-3 sm:-mx-8 sm:px-8">
      <IconButton icon="arrowRight" aria-label="Back to issues" className="rotate-180" onClick={onBack} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">{chips}</div>
        <PageTitle className="fg-h3 mt-1.5 break-words">{title}</PageTitle>
      </div>
      {/* Its own row under the title at phone width rather than hidden there: the help tells a
          reader to choose Reopen at the top of the issue page, on whatever screen they read it. */}
      <div data-header="actions" className="flex basis-full flex-wrap items-center gap-2 sm:flex-none sm:basis-auto">
        {actions}
      </div>
      {failure && (
        <div data-header="failure" className="basis-full">
          {failure}
        </div>
      )}
    </div>
  );
});

export interface FailedHeaderRead {
  what: string;
  error: unknown;
  retry?: (() => void) | undefined;
}

/**
 * Every failed read the header rests on, on its one row: named in one sentence, with one Retry that
 * reads again each read offering it (ISS-1228 r25). Nothing where none failed.
 */
export function HeaderReadFailures({ reads }: { reads: ReadonlyArray<FailedHeaderRead> }) {
  if (reads.length === 0) return null;
  // Only the reads a second read can change are read again, by the one rule (ISS-1229 r50).
  const again = reads.filter((r) => r.retry && offersRetryFor(r.error));
  return (
    <HeaderReadFailure
      said={couldNotReadAll(reads)}
      error={again[0]?.error ?? reads[0]?.error}
      retry={
        again.length > 0
          ? () => {
              for (const r of again) r.retry?.();
            }
          : undefined
      }
    />
  );
}

/** A read the header rests on that failed, said as what could not be read and why, with Retry where its error allows one. */
export function HeaderReadFailure({
  said,
  error,
  retry,
}: {
  said: string;
  error: unknown;
  retry?: (() => void) | undefined;
}) {
  return (
    <div className="fg-caption flex flex-wrap items-center gap-2 text-muted">
      <span role="status">{said}</span>
      <RetryButton error={error} onRetry={retry} />
    </div>
  );
}
