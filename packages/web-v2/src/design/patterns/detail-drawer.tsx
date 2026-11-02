// A record's detail and Properties, opened on demand in a side sheet (REQ-11 BC-22): the page keeps
// its name, its status and its one next action, and every other fact is one click away here, never an
// inline rail. The trigger is a quiet button naming what opens; the sheet is the SlideOver, and what it
// holds is not drawn while it is shut.

import { type ReactNode, useState } from "react";
import { Button } from "../primitives/button";
import type { IconName } from "../icons/icon";
import { SlideOver } from "./slide-over";

interface DetailDrawerProps {
  /** The trigger's words: "Properties", "Details". */
  label: string;
  /** The sheet's heading; the label when absent. */
  title?: ReactNode;
  /** How many facts or items wait inside, beside the label. */
  count?: number;
  icon?: IconName;
  children: ReactNode;
  width?: number;
  /** Controlled: the screen opens it itself (a row's "open", a `?path=` link). */
  open?: boolean;
  /** `false` draws no trigger: the screen's own rows open it, controlled. */
  trigger?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
}

export function DetailDrawer({
  label,
  title,
  count,
  icon = "panelRightOpen",
  children,
  width = 440,
  open,
  onOpenChange,
  trigger = true,
  testId,
}: DetailDrawerProps) {
  const [own, setOwn] = useState(false);
  const shown = open ?? own;
  const set = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <>
      {trigger ? (
        <Button
          variant="ghost"
          size="sm"
          icon={icon}
          aria-haspopup="dialog"
          aria-expanded={shown}
          onClick={() => set(true)}
          data-detail-drawer=""
          data-testid={testId}
        >
          {label}
          {count !== undefined ? (
            <span className="text-12 font-medium text-muted">{count}</span>
          ) : null}
        </Button>
      ) : null}
      <SlideOver
        open={shown}
        onClose={() => set(false)}
        title={title ?? label}
        width={width}
      >
        {children}
      </SlideOver>
    </>
  );
}
