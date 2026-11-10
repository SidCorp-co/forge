// REQ-43 r3 BC-14 (owner, 2026-11-10): Runners opens on its overview above the devices it lists, each
// health's count there the count of rows reading it (L-57), a turned-off device reading Off as its row does.
//
// @direct-test-of packages/web-v2/src/features/runners/components/runners-band.tsx
// @direct-test-of packages/web-v2/src/features/runners/components/runners-screen.tsx

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SCREENS } from "@/test/vi-chrome-runners";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

describe("the Runners overview band", () => {
  it("sits above the devices, each health counting the rows that read it", async () => {
    const fleet = SCREENS.find((s) => s.name === "Runners");
    if (!fleet) throw new Error("no Runners screen in the fixture");
    render(fleet.render());
    const rows = await screen.findAllByTestId("device-row");
    const [first] = rows;
    if (!first) throw new Error("no device row drawn");
    const band = screen.getByTestId("runners-band");
    expect(band.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // each part by the word its row's status cell says, so the band is read against what the rows show
    const parts = new Map(
      within(band)
        .getAllByTestId("coverage-part")
        .map((p) => {
          const n = within(p).getByTestId("coverage-part-count").textContent ?? "";
          return [(p.textContent ?? "").replace(n, "").trim(), Number(n)];
        }),
    );
    const listed = new Map<string, number>();
    for (const r of rows) {
      const said = (r.querySelectorAll("td")[1]?.textContent ?? "").trim();
      listed.set(said, (listed.get(said) ?? 0) + 1);
    }
    expect(parts).toEqual(listed);
    expect(within(band).queryByTestId("chart-table")).toBeNull();
  });
});
