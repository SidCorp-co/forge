// Threads while a thread is open (ISS-1073 round 3): round 2 hid every way to Threads until a thread is
// open for the person, and the live pass could not check the other half, there being no open thread.
// With one open: the Ecosystem page links to Threads, a project's ecosystem tabs carry it, and Threads
// lists the thread's row. With every thread closed: no link and no tab.
// @direct-test-of packages/web-v2/src/features/ecosystem/inbox.ts
// @direct-test-of packages/web-v2/src/features/ecosystem/components/ecosystem-page.tsx

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EcosystemPage } from "@/features/ecosystem/components/ecosystem-page";
import { EcosystemsHome } from "@/features/ecosystem/components/ecosystems-home";
import { ThreadsScreen } from "@/features/ecosystem/components/threads-screen";
import type { RegisterRow, WorkspaceRead } from "@/features/ecosystem/types";
import { Seeded } from "@/test/vi-chrome-requirements";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useParams: () => ({ slug: "hop" }) }));

afterEach(cleanup);

const SUBJECT = "Orders API: the total field changes";
const thread = (open: boolean): RegisterRow & { ecosystem: string } => ({
  number: "CN-7",
  type: "change-notice",
  subject: SUBJECT,
  from: "p2",
  to: ["p1"],
  inReplyTo: null,
  thread: "t7",
  state: "published",
  authoredBy: { kind: "agent" } as RegisterRow["authoredBy"],
  publishedAt: "2026-11-06T00:00:00Z",
  dueBy: "2026-12-01",
  recipients: [],
  open,
  overdue: false,
  owner: ["p1"],
  hold: null,
  ecosystem: "e1",
});
const read = (open: boolean): WorkspaceRead => ({
  ecosystems: [{ id: "e1", slug: "eco-a", name: "Eco A", purpose: null, code: "EA", steward: { id: "o1", name: null, mine: true }, visibility: "all", responseDays: {} as WorkspaceRead["ecosystems"][number]["responseDays"], gate: {} as WorkspaceRead["ecosystems"][number]["gate"], members: ["p1", "p2"] }],
  invitations: [],
  threads: [thread(open)],
  drafts: [],
  projects: [{ id: "p1", slug: "hop", name: "HOP" }, { id: "p2", slug: "shop", name: "Shop" }] as WorkspaceRead["projects"],
  mine: ["p1"],
});
const PROJECT = { id: "p1", slug: "hop", name: "HOP", role: "admin", orgId: null, orgRole: null };

function draw(open: boolean) {
  return render(
    <Seeded data={[[["ecosystem", "mine"], read(open)], [["projects"], [PROJECT]]]}>
      <section data-testid="home">
        <EcosystemsHome />
      </section>
      <section data-testid="tabs">
        <EcosystemPage section="api" title="Project API">
          {() => <p>api</p>}
        </EcosystemPage>
      </section>
      <section data-testid="threads">
        <ThreadsScreen filters={{ view: null, ecosystem: null, project: null, type: null }} onParam={() => {}} />
      </section>
    </Seeded>,
  );
}

describe("Threads while a thread is open", () => {
  it("is linked from the Ecosystem page and a project's ecosystem tabs, and lists the open thread's row", async () => {
    draw(true);
    expect(within(screen.getByTestId("home")).getByRole("link", { name: /Threads/ })).toHaveAttribute("href", "/ecosystems/threads");
    await waitFor(() => expect(within(screen.getByTestId("tabs")).getByRole("link", { name: /Threads/ })).toHaveAttribute("href", "/ecosystems/threads"));
    expect(within(screen.getByTestId("threads")).getByText(SUBJECT)).toBeInTheDocument();
  });

  it("is linked from nowhere once every thread is closed", async () => {
    draw(false);
    await waitFor(() => expect(within(screen.getByTestId("tabs")).getByRole("link", { name: /Project API/ })).toBeInTheDocument());
    expect(screen.queryAllByRole("link", { name: /Threads/ })).toHaveLength(0);
    expect(within(screen.getByTestId("threads")).queryByText(SUBJECT)).toBeNull();
  });
});
