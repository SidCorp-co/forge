"use client";

import { Button, type ButtonProps } from "../primitives/button";

export interface RowAction {
  id: string;
  label: string;
  onClick: () => void;
  variant?: ButtonProps["variant"];
  expanded?: boolean;
}

export interface RowActionsProps {
  actions: readonly (RowAction | false | null | undefined)[];
  busy?: boolean;
  subject: string;
}

/**
 * A row's actions. One it cannot take is left out, never drawn disabled, so none has a disabled state here.
 * They wrap onto a second line rather than widen the column, so a row never needs the table to scroll to
 * reach one.
 */
export function RowActions({ actions, busy = false, subject }: RowActionsProps) {
  const shown = actions.filter((a): a is RowAction => Boolean(a));
  if (shown.length === 0) return null;
  return (
    <div className="flex max-w-[9.5rem] flex-wrap justify-end gap-2 sm:max-w-none">
      {shown.map((a) => (
        <Button
          key={a.id}
          size="sm"
          variant={a.variant ?? "secondary"}
          disabled={busy}
          aria-expanded={a.expanded}
          aria-label={`${a.label}, ${subject}`}
          onClick={a.onClick}
          className="min-h-11 md:min-h-8"
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}
