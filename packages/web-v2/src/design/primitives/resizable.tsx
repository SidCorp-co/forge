"use client";

// Split panes the reader can drag apart (react-resizable-panels through shadcn): the list beside its
// peek, a dock beside the page. Sizes are percentages, or pixels as "320px"; `id` on the group
// remembers the split per browser.

export { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
