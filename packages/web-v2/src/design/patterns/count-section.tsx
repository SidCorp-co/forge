// A section shut by default that shows only its label and how many it holds (REQ-11 BC-22):
// "Criteria 3", "Activity 14". A click opens it in place. One that holds nothing is a quiet line with
// its zero, with nothing to open. It is the Disclosure fold with a count it must carry; a note beside
// the count is a few words at most ("2 open · 1 blocks the agree"), never a sentence.

import type { ReactNode } from "react";
import { Disclosure } from "../primitives/disclosure";

interface CountSectionProps {
  label: string;
  count: number;
  /** A few words beside the count, read while it is shut. */
  note?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
  /** The `data-highlight` the chat's ui.highlight finds it by. */
  highlight?: string;
}

export function CountSection({ label, count, note, children, defaultOpen = false, open, onOpenChange, testId, highlight }: CountSectionProps) {
  if (count === 0) {
    return (
      <div data-testid={testId} data-count-section="empty" data-highlight={highlight} className="flex h-row items-center gap-3 border-t border-line-subtle pl-7 first:border-t-0">
        <span className="text-14 font-medium text-muted">
          {label}
          <span className="ml-1.5 text-12 font-medium text-subtle">0</span>
        </span>
      </div>
    );
  }
  return (
    <Disclosure title={label} count={count} summary={note} defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange} testId={testId} highlight={highlight}>
      {children}
    </Disclosure>
  );
}
