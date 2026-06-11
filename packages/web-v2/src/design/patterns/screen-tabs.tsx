"use client";

// Canonical tabbed-screen header. Every project/workspace screen that uses a
// horizontal tab strip (Settings · Project Settings · Library · Automation ·
// Agents-mobile) renders it through this one pattern so the strip's container —
// max-width, horizontal padding, top spacing, and overflow-x behaviour — is
// identical everywhere (ISS-349). Previously each screen wrapped <Tabs> in its
// own ad-hoc <div>, so comparable surfaces (Project Settings vs Library) drifted
// into two visible styles. This is the single source for that container.
//
// Purely presentational: URL/tab state is owned by the caller (the shared
// `useTabParam` hook), passed in as `value`/`onChange`.

import { cn } from "@/lib/utils/cn";
import { Tabs, type TabsProps } from "../primitives/tabs";

export interface ScreenTabsProps extends TabsProps {
  /** Max-width utility for the strip column. Defaults to the shared wide
   *  shell width (matches PageContainer). */
  width?: string;
  /** Optional content rendered above the strip, in the same centered column
   *  (e.g. a screen-level header). Settings screens use this; the merged shells
   *  pass nothing and let each tab's child screen own its chrome. */
  header?: React.ReactNode;
}

export function ScreenTabs({ tabs, value, onChange, width = "max-w-[1720px]", header }: ScreenTabsProps) {
  return (
    <div className={cn("mx-auto w-full px-4 pt-6 sm:px-8 sm:pt-8", width)}>
      {header}
      <div className="overflow-x-auto">
        <Tabs tabs={tabs} value={value} onChange={onChange} />
      </div>
    </div>
  );
}
