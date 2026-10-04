// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NotificationItem, NotificationsMenu } from "./notifications-menu";

expect.extend(matchers);
afterEach(cleanup);

const stranded: NotificationItem = {
  id: "d1",
  subjectKey: "ISS-1409",
  type: "issue_stranded",
  text: "is waiting on you — hop",
  sub: "Parked at needs_info since 2026-10-03T09:12:44Z\nfield: waiting_kind = person",
  time: "6h",
  unread: true,
  hue: "amber",
};

describe("a notification row", () => {
  it("shows the entity key, one line and the type as a sentence-case badge, never a raw tag", () => {
    render(<NotificationsMenu items={[stranded]} />);
    const row = screen.getByTestId("notification-row");
    expect(within(row).getByTestId("notification-key")).toHaveTextContent("ISS-1409");
    expect(within(row).getByText("is waiting on you — hop")).toBeInTheDocument();
    expect(within(row).getByTestId("enum-badge")).toHaveTextContent("Stranded");
    expect(within(row).getByTestId("enum-badge")).toHaveAttribute("title", "type: issue_stranded");
    expect(row).not.toHaveTextContent("STRANDED");
  });

  it("keeps the long body behind Details, closed until asked, without opening the entity", () => {
    const onSelect = vi.fn();
    render(<NotificationsMenu items={[stranded]} onSelect={onSelect} />);
    expect(screen.queryByTestId("notification-details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("notification-details")).toHaveTextContent("field: waiting_kind = person");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(screen.queryByTestId("notification-details")).toBeNull();
  });

  it("offers no Details control when there is no body to show", () => {
    render(<NotificationsMenu items={[{ ...stranded, sub: undefined }]} />);
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("reads a cleared one as resolved beside its type", () => {
    render(<NotificationsMenu items={[{ ...stranded, resolved: true, unread: false }]} />);
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Resolved");
  });
});
