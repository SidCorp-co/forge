// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationsApi, invitationsApi } from "./api";
import { useNotifications, usePendingInvitations, useUnreadCount } from "./hooks";

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });

const tick = () => new Promise<void>((r) => setTimeout(r, 40));

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the bell fetches, at a given dropdown state. */
function bell(qc: QueryClient, open: boolean) {
  return renderHook(
    () => ({
      list: useNotifications(open),
      pending: usePendingInvitations(open),
      unread: useUnreadCount(),
    }),
    { wrapper: wrapper(qc) },
  );
}

describe("what the notification bell fetches while it is closed", () => {
  // cm:guard the bell component must stay MOUNTED while closed — its own header comment says so, because the realtime delivery and unread-indicator bridges hang off it — and that is a different thing from FETCHING while closed. Both lists feed a menu that renders only under `open` (ISS-1019).
  it("fetches neither list while the dropdown is closed", async () => {
    const qc = client();
    const list = vi.spyOn(notificationsApi, "list").mockResolvedValue({ items: [], totalCount: 0 });
    const pending = vi.spyOn(invitationsApi, "pending").mockResolvedValue([]);
    const unread = vi.spyOn(notificationsApi, "unreadCount").mockResolvedValue({ count: 0 });

    const view = bell(qc, false);
    await tick();

    expect(list).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(unread).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // cm:guard the unread count is NOT gated, and this is what says so: the favicon dot and the `(N)` document-title prefix read it while the bell is closed, so gating it would take a surface away rather than a request.
  it("still fetches the unread count while the dropdown is closed", async () => {
    const qc = client();
    vi.spyOn(notificationsApi, "list").mockResolvedValue({ items: [], totalCount: 0 });
    vi.spyOn(invitationsApi, "pending").mockResolvedValue([]);
    const unread = vi.spyOn(notificationsApi, "unreadCount").mockResolvedValue({ count: 4 });

    const view = bell(qc, false);
    await waitFor(() => expect(view.result.current.unread.data?.count).toBe(4));
    expect(unread).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // cm:guard the other half of the gate, and the half a closed-only test would let an implementation lose entirely: `enabled: false` that never flips to true is indistinguishable from a bell that fetches nothing, and every case above still passes.
  it("starts both list requests when the dropdown opens", async () => {
    const qc = client();
    const list = vi.spyOn(notificationsApi, "list").mockResolvedValue({ items: [], totalCount: 0 });
    const pending = vi.spyOn(invitationsApi, "pending").mockResolvedValue([]);
    vi.spyOn(notificationsApi, "unreadCount").mockResolvedValue({ count: 0 });

    const closed = bell(qc, false);
    await tick();
    expect(list).not.toHaveBeenCalled();
    closed.unmount();

    const opened = bell(qc, true);
    await waitFor(() => expect(opened.result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(opened.result.current.pending.isSuccess).toBe(true));

    expect(list).toHaveBeenCalledTimes(1);
    expect(pending).toHaveBeenCalledTimes(1);
    opened.unmount();
  });
});
