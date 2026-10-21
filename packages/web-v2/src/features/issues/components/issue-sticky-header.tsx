import { Button } from "@/design/primitives/button";
import { PageTitle } from "@/design/primitives/heading";
import { IconButton } from "@/design/primitives/icon-button";
import { forwardRef, type ReactNode } from "react";

/**
 * The issue page's sticky bar, opaque so nothing scrolls through it. A failed read's sentence has a
 * line of its own under the title and actions: in the toolbar it squeezed the title (ISS-1228 r24).
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

/** A read the header rests on that failed, said as what could not be read and why, with Retry where it is offered. */
export function HeaderReadFailure({ said, retry }: { said: string; retry?: (() => void) | undefined }) {
  return (
    <div role="status" className="fg-caption flex flex-wrap items-center gap-2 text-muted">
      <span>{said}</span>
      {retry && (
        <Button variant="secondary" size="sm" icon="rerun" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
