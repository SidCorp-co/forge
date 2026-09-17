// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The bridge's four collaborators. Each one is a surface that INTERRUPTS, which is the
// whole subject of this file: the bell is driven separately, by query invalidation.
const toast = vi.fn();
const fireBrowserNotification = vi.fn();
const playNotificationSound = vi.fn();
let emit: (env: { event: string; data: unknown }) => void = () => {};

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/notifications/browser", () => ({
  fireBrowserNotification: (...args: unknown[]) => fireBrowserNotification(...args),
}));
vi.mock("@/lib/notifications/sound", () => ({
  installGesturePrimer: () => {},
  playNotificationSound: () => playNotificationSound(),
}));
vi.mock("@/lib/ws/client", () => ({
  wsClient: {
    on: (handler: (env: { event: string; data: unknown }) => void) => {
      emit = handler;
      return () => {};
    },
  },
}));

const { useNotificationDelivery } = await import("./use-notification-delivery");

afterEach(() => {
  vi.clearAllMocks();
});

function created(data: Record<string, unknown>) {
  emit({
    event: "notification.created",
    data: {
      notificationId: "n1",
      type: "pipeline_wedge",
      title: "the pipeline is wedged",
      severity: "error",
      issueId: null,
      projectId: null,
      ...data,
    },
  });
}

describe("what a grouped delivery is allowed to interrupt (ISS-1063)", () => {
  it("interrupts once for a group the server already announced", () => {
    renderHook(() => useNotificationDelivery(() => {}));

    // What fifteen stranded issues raised in one sweep look like on the wire: one
    // founding event that may interrupt, fourteen that join the same bell row.
    created({ notificationId: "n1", announce: true });
    for (let i = 2; i <= 15; i += 1) created({ notificationId: `n${i}`, announce: false });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(fireBrowserNotification).toHaveBeenCalledTimes(1);
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("interrupts for an event carrying no flag at all", () => {
    renderHook(() => useNotificationDelivery(() => {}));
    created({});

    // An ungrouped notification, and anything a server older than this change sends.
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
