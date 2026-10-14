import { useId } from "react";

/** The ✓'s path; a short draws it hollow, a wide stroke with a narrow one cut out of it. */
const CHECK_PATH = "M3 8.6 6.6 12.2 13 4.6";

/**
 * A short's mark: the pass's ✓ drawn hollow, in whatever tone its parent sets. A short is met short
 * of its wording and never proven, so wherever a criterion is drawn, it never reads as a pass
 * (forge-core-eb, 2026-10-14). The parent names it; this draws only.
 */
export function HollowCheck() {
  const maskId = `hollow-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg viewBox="0 0 16 16" className="inline-block size-4 align-middle" aria-hidden="true" data-mark="hollow">
      <mask id={maskId}>
        <path d={CHECK_PATH} fill="none" stroke="white" strokeWidth={4.6} strokeLinecap="round" strokeLinejoin="round" />
        <path d={CHECK_PATH} fill="none" stroke="black" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <rect width="16" height="16" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
