import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CurrentProjectProvider } from "@/features/projects/current-project";
import type { ProjectListItem } from "@/features/projects/types";
import { LandsThisWeek } from "@/features/project-dashboard/components/plan-sections";
import { fakeCore, renderWithQuery } from "@/test/render";
import { resolveInterfaceLanguage, WorkspaceInterfaceLanguage } from "./interface-language";
import { PRODUCT_STRINGS as product } from "./product-copy";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const project = { id: "p1", slug: "hop" } as ProjectListItem;
const clock = { lang: "en" as const, now: Date.parse("2026-10-07T12:00:00Z") };

function screenWith(choice: "en" | "vi" | null, content: string) {
  fakeCore((call) => {
    if (call.path === "/auth/me/preferences") return { body: { theme: "system", language: choice, notifyOnMention: true, activeOrgId: null, updatedAt: null } };
    if (call.path === "/projects/p1/content-language") return { body: { contentLanguage: content } };
    return undefined;
  });
  renderWithQuery(
    <CurrentProjectProvider project={project}>
      <WorkspaceInterfaceLanguage>
        <LandsThisWeek rows={[]} clock={clock} slug="hop" />
      </WorkspaceInterfaceLanguage>
    </CurrentProjectProvider>,
  );
}

describe("the interface language a screen renders in", () => {
  it("resolves the explicit choice, then the project's content language, then English", () => {
    expect(resolveInterfaceLanguage("vi", "en")).toBe("vi");
    expect(resolveInterfaceLanguage("en", "vi-VN")).toBe("en");
    expect(resolveInterfaceLanguage(null, "vi-VN")).toBe("vi");
    expect(resolveInterfaceLanguage(null, "fr")).toBe("en");
    expect(resolveInterfaceLanguage(undefined, undefined)).toBe("en");
  });

  it("renders vi when the person picks vi on a project that writes English", async () => {
    screenWith("vi", "en");
    expect(await screen.findByText(product.vi["dash.landsEmpty"])).toBeInTheDocument();
  });

  it("renders English when the person picks English on a project that writes Vietnamese", async () => {
    screenWith("en", "vi");
    expect(await screen.findByText(product.en["dash.landsEmpty"])).toBeInTheDocument();
    expect(screen.queryByText(product.vi["dash.landsEmpty"])).toBeNull();
  });

  it("follows the project's content language when the person chose nothing", async () => {
    screenWith(null, "vi");
    expect(await screen.findByText(product.vi["dash.landsEmpty"])).toBeInTheDocument();
  });
});
