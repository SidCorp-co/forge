// The Approvals page's face (REQ-11 BC-22, ISS-903): a row is its subject's title, the proposal and one
// chip, the key the title's tooltip and the proposal's tags the chip's hover; the topics are the
// palette's acts, never a chip row; what the count leaves out is one shut line with how many it holds;
// and the page's one next action opens the first decision's peek.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approvals-screen.tsx
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-row.tsx

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, PageCommandsProvider, usePageCommandList } from "@/design";
import { APPROVALS_PROJECT as P, APPROVALS_READ as READ } from "@/test/approvals-read";
import { core, openAt, rowOf } from "@/test/approvals-page";
import { ApprovalsScreen } from "./components/approvals-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

function Palette() {
  return <CommandPalette open onClose={() => {}} commands={usePageCommandList()} />;
}

function page({ palette = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PageCommandsProvider>
        <ApprovalsScreen projectId={P} slug="hop" />
        {palette ? <Palette /> : null}
      </PageCommandsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => openAt());

describe("the Approvals face", () => {
  it("names a row by its subject's title, its key the title's tooltip, never text on the face", async () => {
    core();
    page();
    await screen.findByTestId("approvals-screen");
    const title = within(rowOf("FB-135")).getByTestId("approval-title");
    expect(title).toHaveAttribute("title", "FB-135");
    expect(title.textContent).not.toContain("FB-135");
  });

  it("draws one chip a row, the proposal's tags its hover and its spoken reason", async () => {
    core();
    page();
    await screen.findByTestId("approvals-screen");
    const chip = within(rowOf("FB-135")).getByTestId("approval-tags");
    expect(chip).toHaveAttribute("data-reason", expect.stringMatching(/Bug · medium · Not reproduced/));
    expect(chip.querySelector(".sr-only")).toHaveTextContent("Not reproduced");
  });

  it("draws no topic chip row; the topics are the palette's, and one narrows the list", async () => {
    core();
    const user = userEvent.setup();
    page({ palette: true });
    await screen.findByTestId("approvals-screen");
    expect(screen.queryByTestId("approval-chip-feedback")).toBeNull();
    const palette = await screen.findByRole("dialog");
    expect(within(palette).getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining(["Only Feedback", "Only Breakdowns", "Only Design updates", "Only Mockups"]));
    await user.click(within(palette).getByRole("option", { name: "Only Feedback" }));
    expect(screen.getAllByTestId("approval-row").map((r) => r.dataset.topic)).toEqual(["feedback", "feedback", "feedback"]);
    expect(window.location.search).toContain("topic=feedback");
  });

  it("shuts what the count leaves out to one line with how many it holds", async () => {
    core();
    page();
    await screen.findByTestId("approvals-screen");
    const fold = screen.getByTestId("approvals-left-out");
    const held = READ.notDecisions.reduce((n, d) => n + d.count, READ.total - READ.decisions.length);
    expect(fold).toHaveTextContent(`Not counted here${held}`);
    expect(within(fold).queryAllByTestId("approvals-left-out-item")).toHaveLength(0);
  });

  it("leads with deciding the next one, which opens its peek", async () => {
    core();
    const user = userEvent.setup();
    page();
    await screen.findByTestId("approvals-screen");
    await user.click(screen.getByTestId("approvals-next"));
    expect(await screen.findByTestId("approval-peek")).toBeInTheDocument();
  });
});
