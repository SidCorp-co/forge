
// Split panes the reader can drag apart (react-resizable-panels through shadcn): the list beside its
// peek, a dock beside the page. Sizes are percentages, or pixels as "320px". A group forgets its
// split when it unmounts; `useRememberedSplit` keeps the one the reader dragged to, per browser.

import { type LayoutStorage, useDefaultLayout } from "react-resizable-panels";

export { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";

// Storage that a private window or blocked site data refuses: the split is then not kept, and the
// panes open at their default sizes as they would on a first visit.
const browserStorage: LayoutStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
};

/** Spread onto a ResizablePanelGroup: it opens at the split the reader last dragged it to. */
export function useRememberedSplit(id: string, panelIds: string[]) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `web-v2:split:${id}`, panelIds, storage: browserStorage, onlySaveAfterUserInteractions: true });
  return { defaultLayout, onLayoutChanged };
}
