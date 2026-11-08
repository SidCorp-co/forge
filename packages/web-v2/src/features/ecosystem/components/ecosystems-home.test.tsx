// The Ecosystem is one rail row (ISS-1073), so its page is where Threads is opened: a link the person
// sees only while a thread exists for them, with what waits on them counted beside it.
// @direct-test-of packages/web-v2/src/features/ecosystem/components/ecosystems-home.tsx

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { Seeded } from "@/test/vi-chrome-requirements";
import type { WorkspaceRead } from "../types";
import { EcosystemsHome } from "./ecosystems-home";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const ECO = { id: "e1", slug: "eco-a", name: "Eco A", purpose: null, code: "EA", steward: { id: "o1", name: null, mine: true }, visibility: "all", responseDays: {}, gate: {}, members: ["p1"] };
const read = (threads: unknown[]): WorkspaceRead =>
  ({ ecosystems: [ECO], invitations: [], threads, drafts: [], projects: [{ id: "p1", slug: "hop", name: "HOP" }], mine: ["p1"] }) as unknown as WorkspaceRead;
const thread = { number: "CN-1", ecosystem: "e1", type: "contract-notice", from: "p2", to: ["p1"], owner: ["p1"], state: "open", open: true, overdue: false, dueBy: null };

const draw = (r: WorkspaceRead) =>
  renderWithQuery(
    <Seeded data={[[["ecosystem", "mine"], r]]}>
      <EcosystemsHome />
    </Seeded>,
  );

describe("the Ecosystem page", () => {
  it("offers Threads while a thread exists", () => {
    draw(read([thread]));
    expect(screen.getByRole("link", { name: /Threads/ })).toHaveAttribute("href", "/ecosystems/threads");
  });

  // on forge-dev the link led to "Nothing here": every thread there was a closed test fixture (ISS-1073 round 2)
  it("offers no Threads while every thread is closed", () => {
    draw(read([{ ...thread, state: "closed", open: false }]));
    expect(screen.getByText("Eco A")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Threads/ })).toBeNull();
  });

  it("offers no Threads while none does", () => {
    draw(read([]));
    expect(screen.getByText("Eco A")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Threads/ })).toBeNull();
  });

  // ISS-1137: a row is the ecosystem's name and its steward's; "Steward" is the name's hover, not a word per row
  it("names each ecosystem's steward without a label repeated on every row", () => {
    renderWithQuery(
      <Seeded data={[[["ecosystem", "mine"], { ...read([]), ecosystems: [{ ...ECO, steward: { id: "o1", name: "SidCorp", mine: false } }] }]]}>
        <EcosystemsHome />
      </Seeded>,
    );
    const steward = screen.getByText("SidCorp");
    expect(steward).toHaveAttribute("title", "Steward · SidCorp");
    expect(screen.queryByText(/Steward/)).toBeNull();
  });
});
