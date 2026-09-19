// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationsApi, invitationsApi } from "./api";
import { useNotifications, usePendingInvitations, useOpenCount } from "./hooks";

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
      open: useOpenCount(),
    }),
    { wrapper: wrapper(qc) },
  );
}

describe("what the notification bell fetches while it is closed", () => {
  it("fetches neither list while the dropdown is closed", async () => {
    const qc = client();
    const list = vi.spyOn(notificationsApi, "list").mockResolvedValue({ items: [], totalCount: 0 });
    const pending = vi.spyOn(invitationsApi, "pending").mockResolvedValue([]);
    const openCount = vi.spyOn(notificationsApi, "openCount").mockResolvedValue({ count: 0 });

    const view = bell(qc, false);
    await tick();

    expect(list).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(openCount).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("still fetches the open count while the dropdown is closed", async () => {
    const qc = client();
    vi.spyOn(notificationsApi, "list").mockResolvedValue({ items: [], totalCount: 0 });
    vi.spyOn(invitationsApi, "pending").mockResolvedValue([]);
    const openCount = vi.spyOn(notificationsApi, "openCount").mockResolvedValue({ count: 4 });

    const view = bell(qc, false);
    await waitFor(() => expect(view.result.current.open.data?.count).toBe(4));
    expect(openCount).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("starts both list requests when the dropdown opens", async () => {
    const qc = client();
    const list = vi.spyOn(notificationsApi, "list").mockResolvedValue({ items: [], totalCount: 0 });
    const pending = vi.spyOn(invitationsApi, "pending").mockResolvedValue([]);
    vi.spyOn(notificationsApi, "openCount").mockResolvedValue({ count: 0 });

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
