// @vitest-environment jsdom
//
// ISS-1421 r8 — one naming rule on the Connections list: a row says what it points at once, in its
// title where the title already names it, and on the line beneath only where the title does not.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

vi.mock("../hooks", () => ({
  useCanManageConnection: () => true,
  useRemoveConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateConnection: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { ConnectionRow } = await import("./connection-row");

const coolify = (displayName: string | null): ConnectionDirectoryItem => ({
  id: "c1",
  ownerType: "user",
  ownerId: "u1",
  provider: "coolify",
  displayName,
  config: { baseUrl: "https://coolify.example.test" },
  active: true,
  lastHealthStatus: null,
  lastHealthAt: null,
  breakerOpenedAt: null,
  hasSecrets: false,
  createdAt: "2026-10-12T09:00:00Z",
  updatedAt: "2026-10-12T09:00:00Z",
  usage: { bindings: [] },
  access: { reach: "owner", canManage: true, ownerName: null },
});

const row = (c: ConnectionDirectoryItem) =>
  render(<ConnectionRow connection={c} ownerLabel="Personal" projectName={(id) => id} onOpen={() => {}} />);

afterEach(cleanup);

describe("ConnectionRow", () => {
  it("names the host once where the connection is named by it", () => {
    row(coolify("coolify.example.test"));
    expect(screen.getAllByText("coolify.example.test")).toHaveLength(1);
  });

  it("wraps a long title rather than cutting off the words that tell two connections apart", () => {
    row(coolify(null));
    expect(screen.getByTestId("connection-title").className).not.toMatch(/\btruncate\b/);
  });

  it("keeps the host on the line beneath a name of the owner's own", () => {
    row(coolify("Staging deploys"));
    expect(screen.getByText("Staging deploys")).toBeInTheDocument();
    expect(screen.getByText("coolify.example.test")).toBeInTheDocument();
  });
});

// ISS-1421 r21 — the after-shots: a removed connection's row still offered Enable, which core
// refuses CONNECTION_HAS_NO_KEY, and Remove where the drawer says Clear.
describe("ConnectionRow over a removed connection", () => {
  const removed = { ...coolify("Old deploys"), active: false, hasSecrets: false };

  it("offers no Enable, and Clear in place of Remove", () => {
    row(removed);
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Clear it from the list?")).toBeInTheDocument();
  });

  it("keeps Enable on a connection someone disabled that still holds its key", () => {
    row({ ...removed, hasSecrets: true });
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});
