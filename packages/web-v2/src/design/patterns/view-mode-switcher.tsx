"use client";

import { useUrlChoice } from "../hooks/use-url-params";
import type { IconName } from "../icons/icon";
import { SegmentedControl } from "../primitives/segmented-control";

export interface ViewMode<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Why it is offered, or why it is off: on hover. */
  title?: string;
  disabled?: boolean;
}

/** `?group=` over the list's modes; the first is the default and is not written. */
export function useViewMode<T extends string>(modes: readonly ViewMode<T>[]): [T, (m: T) => void] {
  return useUrlChoice(
    "group",
    modes.map((m) => m.value),
    modes[0]?.value as T,
  );
}

export function ViewModeSwitcher<T extends string>({
  modes,
  value,
  onChange,
  placement,
}: {
  modes: readonly ViewMode<T>[];
  value: T;
  onChange: (m: T) => void;
  /** `header` shows from 768px up (PageTitle's `after`); `toolbar` only below it. */
  placement: "header" | "toolbar";
}) {
  return (
    <span
      className={placement === "header" ? "ml-2 inline-flex max-md:hidden" : "inline-flex md:hidden"}
      data-testid={`view-mode-${placement}`}
      title="Group by"
    >
      <SegmentedControl options={modes.map((m) => ({ ...m }))} value={value} onChange={onChange} />
    </span>
  );
}
