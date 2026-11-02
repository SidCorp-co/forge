// The status report's face (ISS-903): each part one line shut to its title and count, when its read
// answered that line's hover; what is stuck and what needs you stand open; every part's body stays in
// the page, hidden, so the printed report is the whole report; Copy and Print are the palette's.
//
// @direct-test-of packages/web-v2/src/features/project-status/components/report-part.tsx

import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, PageCommandsProvider, usePageCommandList } from "@/design";
import { AT, STATUS } from "@/test/project-status";
import { StatusReport } from "./status-report";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

Element.prototype.scrollIntoView = () => {};

const clock = { lang: "en" as const, now: Date.parse(AT), timeZone: "UTC" };

function Palette() {
  return <CommandPalette open onClose={() => {}} commands={usePageCommandList()} />;
}

function report(palette = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PageCommandsProvider>
        <StatusReport s={STATUS} slug="hop" clock={clock} window="7" onWindow={() => {}} />
        {palette ? <Palette /> : null}
      </PageCommandsProvider>
    </QueryClientProvider>,
  );
}

const fold = (part: string) => {
  const line = within(screen.getByTestId(part)).getAllByRole("button")[0];
  if (!line) throw new Error(`${part} draws no line`);
  return line;
};

describe("the status report's face", () => {
  it("shuts each part to its title and count, its read time the line's hover", () => {
    report();
    const shipped = fold("status-shipped");
    expect(shipped).toHaveAttribute("aria-expanded", "false");
    expect(shipped).toHaveTextContent(`Shipped${STATUS.shipped.releaseCount}`);
    expect(shipped.getAttribute("title")).toMatch(/^read /);
    expect(screen.getByTestId("status-report").textContent).not.toMatch(/read \d/);
  });

  it("keeps a shut part's body in the page, hidden on screen, for the print", () => {
    report();
    const body = screen.getByTestId("status-shipped").querySelector("[data-slot=collapsible-content]");
    expect(body).toHaveAttribute("hidden");
    expect(body?.className).toContain("print:block!");
    fireEvent.click(fold("status-shipped"));
    expect(screen.getByTestId("status-shipped").querySelector("[data-slot=collapsible-content]")).not.toHaveAttribute("hidden");
  });

  it("carries Copy and Print in the palette, and draws neither on the face", async () => {
    report(true);
    expect(screen.queryByRole("button", { name: "Copy as Markdown" })).toBeNull();
    const palette = await screen.findByRole("dialog");
    expect(within(palette).getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining(["Copy as Markdown", "Print"]));
  });
});
