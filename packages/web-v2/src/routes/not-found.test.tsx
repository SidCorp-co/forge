import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RootNotFound as NotFound } from "./-root-not-found";

// A URL under a project that names no page (a stale link such as the retired /skill-updates, ISS-220)
// reads its 404 in English whatever language the person once stored or the project writes in: Forge's
// chrome is English only (owner, 2026-10-08; ISS-1071).

const path = vi.hoisted(() => ({ current: "/projects/hop/skill-updates" }));
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ usePathname: () => path.current, useRouter: () => ({ push: vi.fn() }) }));

function missing(at: string, choice: string | null) {
  path.current = at;
  fakeCore((call) => {
    if (call.path === "/auth/me/preferences") return { body: { theme: "system", language: choice, notifyOnMention: true, activeOrgId: null, updatedAt: null } };
    if (call.path === "/projects") return { body: [{ id: "p1", slug: "hop", name: "HOP" }] };
    if (call.path === "/projects/p1/content-language") return { body: { contentLanguage: "vi" } };
    return undefined;
  });
  renderWithQuery(<NotFound />);
}

describe("the page a missing URL reads", () => {
  it("reads English under a vi project's URL when the person stored nothing", async () => {
    missing("/projects/hop/skill-updates", null);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(screen.queryByText("Không tìm thấy trang")).toBeNull(); // i18n-allow: Vietnamese text under test
  });

  it("reads English even where the person's stored preference says vi", async () => {
    missing("/projects/hop/skill-updates", "vi");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(screen.queryByText("Không tìm thấy trang")).toBeNull(); // i18n-allow: Vietnamese text under test
  });
});
