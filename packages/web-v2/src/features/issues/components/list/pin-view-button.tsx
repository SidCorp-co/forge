"use client";

import { Button, Input, Popover } from "@/design";
import { usePinnedViews } from "@/lib/navigation/pinned-views";
import { useMemo, useRef, useState } from "react";

/** Pin the list as it is filtered now, under a name; a pinned view unpins in one click. */
export function PinViewButton({
  pathname,
  search,
  defaultLabel,
}: {
  pathname: string;
  search: string;
  defaultLabel: string;
}) {
  const pinnedViews = usePinnedViews();
  const viewHref = useMemo(() => {
    const p = new URLSearchParams(search);
    p.delete("new");
    const qs = p.toString();
    return `${pathname}${qs ? `?${qs}` : ""}`;
  }, [pathname, search]);
  const isPinned = pinnedViews.isPinned(viewHref);
  const [pinOpen, setPinOpen] = useState(false);
  const pinAnchor = useRef<HTMLDivElement>(null);
  const [pinName, setPinName] = useState("");

  function onPinClick() {
    if (isPinned) {
      pinnedViews.remove(viewHref);
      return;
    }
    if (pinOpen) {
      setPinOpen(false);
      return;
    }
    setPinName(defaultLabel);
    setPinOpen(true);
  }
  function confirmPin() {
    pinnedViews.toggle({
      id: viewHref,
      label: pinName.trim() || defaultLabel,
      icon: "list",
      href: viewHref,
    });
    setPinOpen(false);
  }

  return (
    <div ref={pinAnchor} className="relative">
      <Button
        variant={isPinned ? "secondary" : "ghost"}
        size="sm"
        icon="pin"
        aria-pressed={isPinned}
        aria-label={isPinned ? "Pinned view" : "Pin view"}
        onClick={onPinClick}
      >
        <span className="hidden sm:inline">{isPinned ? "Pinned" : "Pin view"}</span>
      </Button>
      <Popover
        open={pinOpen}
        anchor={pinAnchor}
        onDismiss={() => setPinOpen(false)}
        placement="bottom-end"
        gap={8}
        takesFocus
        role="dialog"
        aria-label="Pin this view"
        className="w-72 overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-lg"
      >
        <p className="fg-caption mb-2 text-muted">
          Pin this view — current filters are saved with it.
        </p>
        <Input
          value={pinName}
          onChange={(e) => setPinName(e.target.value)}
          placeholder={defaultLabel}
          aria-label="Pin name"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmPin();
            if (e.key === "Escape") setPinOpen(false);
          }}
        />
        <div className="mt-2.5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPinOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={confirmPin}>
            Pin
          </Button>
        </div>
      </Popover>
    </div>
  );
}
