import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type NotificationItem, NotificationsMenu } from "./notifications-menu";


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

  it("offers the row's own actions, and runs the one pressed", () => {
    const onClick = vi.fn();
    render(
      <NotificationsMenu
        items={[{ ...stranded, actions: [{ id: "accept", label: "Accept", variant: "primary", onClick }] }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("a grouped notification", () => {
  const grouped: NotificationItem = { ...stranded, id: "g1", group: { total: 15, open: 3 } };

  it("names how many of its records are still open, and asks the feature to expand it", () => {
    const onToggleGroup = vi.fn();
    render(<NotificationsMenu items={[grouped]} onToggleGroup={onToggleGroup} />);
    const toggle = screen.getByRole("button", { name: "3 of 15 still open · show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(onToggleGroup).toHaveBeenCalledWith("g1");
  });

  it("lists the members it was handed when expanded, a cleared one struck through", () => {
    const onSelectMember = vi.fn();
    render(
      <NotificationsMenu
        items={[grouped]}
        onToggleGroup={vi.fn()}
        expandedId="g1"
        expandedMembers={[
          { id: "m1", text: "ISS-1 stranded", time: "1h", open: true },
          { id: "m2", text: "ISS-2 stranded", time: "2h", open: false },
        ]}
        onSelectMember={onSelectMember}
      />,
    );
    expect(screen.getByRole("button", { name: "3 of 15 still open · hide" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ISS-2 stranded")).toHaveClass("line-through");
    expect(screen.getByText("ISS-1 stranded")).not.toHaveClass("line-through");
    fireEvent.click(screen.getByText("ISS-1 stranded"));
    expect(onSelectMember).toHaveBeenCalledWith("m1");
  });
});

describe("the menu's states", () => {
  it("cannot mark all read with nothing in it, and says it is caught up", () => {
    render(<NotificationsMenu items={[]} onMarkAllRead={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  it("offers a retry when the list could not load", () => {
    const onRetry = vi.fn();
    render(<NotificationsMenu items={[stranded]} error onRetry={onRetry} />);
    expect(screen.queryByTestId("notification-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("the rows the menu has not loaded (ISS-289)", () => {
  it("offers them in a last row, and asks the feature to load them", () => {
    const onLoad = vi.fn();
    render(<NotificationsMenu items={[stranded]} more={{ label: "Show 3 more", onLoad }} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("cannot be pressed twice while a page loads", () => {
    render(<NotificationsMenu items={[stranded]} more={{ label: "Show 3 more", loading: true, onLoad: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });

  it("offers nothing more when it was handed nothing more", () => {
    render(<NotificationsMenu items={[stranded]} />);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });
});

describe("every notification of any state", () => {
  it("is one press away in the footer, even with nothing open", () => {
    const onOpenAll = vi.fn();
    render(<NotificationsMenu items={[]} onOpenAll={onOpenAll} />);
    fireEvent.click(screen.getByRole("button", { name: "All notifications" }));
    expect(onOpenAll).toHaveBeenCalledTimes(1);
  });
});
