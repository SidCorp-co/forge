// A toast or a browser notification opens what it is about, as the bell row does: an issue's notice
// opens the issue, and a sent status report's notice opens the kept report on the History tab.

import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { DeliveryNotification } from "../use-notification-delivery";
import { NotificationsBell } from "./notifications-bell";

const push = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => ({ current: null as ((n: DeliveryNotification) => void) | null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../use-notification-delivery", () => ({
  useNotificationDelivery: (onNavigate: (n: DeliveryNotification) => void) => {
    navigate.current = onNavigate;
  },
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const PROJECT = { id: "p-1", slug: "hop", name: "Hop" };

function renderBell() {
  fakeCore((call) => {
    const url = new URL(call.path, "http://forge.test");
    if (url.pathname === "/notifications/open-count") return { body: { count: 0 } };
    if (url.pathname === "/notifications" && call.method === "GET") return { body: { items: [], total: 0 } };
    if (url.pathname.startsWith("/notifications/")) return { body: {} };
    if (url.pathname === "/projects") return { body: [PROJECT] };
    if (url.pathname === "/invitations/pending") return { body: [] };
    return undefined;
  });
  const anchor = { current: document.body.appendChild(document.createElement("button")) };
  return renderWithQuery(<NotificationsBell open={false} onClose={vi.fn()} anchor={anchor} />);
}

const notice = (over: Partial<DeliveryNotification>): DeliveryNotification => ({
  notificationId: "n-1",
  type: "status_report",
  title: "Hop status report, 5 Oct 2026",
  severity: "info",
  issueId: null,
  projectId: PROJECT.id,
  statusReportId: null,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("clicking a toast", () => {
  it("opens the kept report a status report's notice carries", async () => {
    const { client } = renderBell();
    await waitFor(() => expect(client.getQueryData(["projects"])).toBeTruthy());
    navigate.current?.(notice({ statusReportId: "r-1" }));
    expect(push).toHaveBeenCalledWith("/projects/hop/status?tab=history&report=r-1");
  });

  it("opens the issue an issue's notice names", async () => {
    const { client } = renderBell();
    await waitFor(() => expect(client.getQueryData(["projects"])).toBeTruthy());
    navigate.current?.(notice({ type: "mention", issueId: "i-9" }));
    expect(push).toHaveBeenCalledWith("/projects/hop/issues/i-9");
  });
});
