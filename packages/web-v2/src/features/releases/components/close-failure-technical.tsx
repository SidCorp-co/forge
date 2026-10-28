"use client";

import type { CloseFailure } from "../roster";

/** What Forge said when a release's close failed, for whoever operates Forge (ISS-1421 r41). */
export function CloseFailureTechnical({ failure }: { failure: CloseFailure }) {
  return (
    <details className="fg-caption max-w-full text-muted">
      <summary className="cursor-pointer">Technical details</summary>
      <p className="mt-1 break-words font-mono [overflow-wrap:anywhere]">{failure.reason}</p>
    </details>
  );
}
