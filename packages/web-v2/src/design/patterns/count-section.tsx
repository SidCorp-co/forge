// A section shut by default that shows only its label and one number (REQ-11 BC-22): "Criteria 3",
// "Activity 14". The number is what still asks for a person where the section holds both kinds, never
// its total beside it: "Still unclear 2 open", the answered ones only inside. A click opens it in place.
// One that holds nothing is a quiet line with its zero, with nothing to open; one whose count is zero
// but which still holds settled rows opens all the same. It is the Disclosure fold with a count it must
// carry; a note beside the count qualifies it in a few words ("1 blocks the agree"), never a sentence.
// On a record page it is the DrawerFold instead (`drawer`): its body opens in a side drawer, never in
// place (REQ-43 r3 BC-17).

import type { ReactNode } from "react";
import { Disclosure } from "../primitives/disclosure";
import { DrawerFold } from "./drawer-fold";

interface CountSectionProps {
  label: string;
  /** What still asks for a person, or every row where all of them do. */
  count: number;
  /** The word the count is of, where it is not every row: "open". */
  unit?: string;
  /** How many rows it holds, where more than `count`: the settled ones open with it, uncounted. */
  holds?: number;
  /** A few words beside the count, read while it is shut. */
  note?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
  /** The `data-highlight` the chat's ui.highlight finds it by. */
  highlight?: string;
  /** Opens its body in a side drawer, never in place: a record page's fold. */
  drawer?: boolean;
}

export function CountSection({ label, count, unit, holds, note, children, defaultOpen = false, open, onOpenChange, testId, highlight, drawer = false }: CountSectionProps) {
  if (count === 0 && !holds) {
    return (
      <div data-testid={testId} data-count-section="empty" data-highlight={highlight} className="flex h-row items-center gap-3 border-t border-line-divider pl-7 first:border-t-0">
        <span className="text-14 font-medium text-muted">
          {label}
          <span className="ml-1.5 text-12 font-medium text-subtle">{unit ? `0 ${unit}` : 0}</span>
        </span>
      </div>
    );
  }
  const Fold = drawer ? DrawerFold : Disclosure;
  return (
    <Fold title={label} count={count} countUnit={unit} summary={note} defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange} testId={testId} highlight={highlight}>
      {children}
    </Fold>
  );
}
