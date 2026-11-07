// The Modules screen is one flat list (ISS-1072): no tile map above it repeating its rows, each row
// leading with the module's name, its slug and the issue that last landed kept off the row's text.
// @direct-test-of packages/web-v2/src/features/modules/components/modules-screen.tsx
// @direct-test-of packages/web-v2/src/features/modules/components/module-level.tsx

import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MODULE_QUERIES, MODULES_PROJECT } from "@/test/module-rollup";
import { renderWithQuery } from "@/test/render";
import { Seeded } from "@/test/vi-chrome-requirements";
import { ModulesScreen } from "./modules-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

describe("the Modules screen", () => {
  it("draws one list of the modules, by name, with no tile map", async () => {
    renderWithQuery(
      <Seeded data={MODULE_QUERIES}>
        <ModulesScreen projectId={MODULES_PROJECT} slug="hop" />
      </Seeded>,
    );
    const rows = await screen.findAllByTestId("list-row");
    expect(screen.queryByTestId("module-level-map")).toBeNull();
    expect(screen.queryByText(/Business modules/)).toBeNull();
    expect(rows.map((r) => r.querySelector(".truncate")?.textContent)).toEqual(expect.arrayContaining(["Conversations", "Identity access", "Releases"]));
    for (const row of rows) {
      expect(row.textContent).not.toMatch(/conversations-1|identity-access-2|releases-3|billing-4/);
      expect(within(row).queryByText(/^ISS-\d+$/)).toBeNull();
    }
  });
});
