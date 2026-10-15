// The app's navigation over TanStack Router (router.tsx), under a real router served from a base
// path: a link shows the browser the based href and is followed in-app, a modified click or an
// outside href is the browser's, the hooks read the place without the base path, and a link loads
// its page ahead as the pointer or the focus reaches it.
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderRoute } from "@/test/route-tree";
import { Link, usePathname, useParams, useRouter, useSearchParams } from "./router";

function Place() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  return (
    <div>
      <output data-testid="place">{`${usePathname()} ${useSearchParams().get("tab") ?? "-"} ${params.slug}`}</output>
      <Link href="/projects/hop/issues?tab=open">Issues</Link>
      <Link href="https://forge.example.test/guides">Guides</Link>
      <button type="button" onClick={() => router.push("/projects/hop/requirements")}>Push</button>
      <button type="button" onClick={() => router.replace("/projects/hop/feedback")}>Replace</button>
    </div>
  );
}

const open = () => renderRoute({ at: "/forge/projects/hop?tab=board", pattern: "/projects/$slug/$", page: Place, basepath: "/forge" });
const openAtProject = () =>
  renderRoute({ at: "/forge/projects/hop?tab=board", pattern: "/projects/$slug", page: Place, basepath: "/forge" });

describe("the app's navigation under a base path", () => {
  it("reads the path without the base path, the query, and the route's params", async () => {
    await openAtProject();
    expect(screen.getByTestId("place")).toHaveTextContent("/projects/hop board hop");
  });

  it("shows the browser a link's href under the base path, and leaves an outside href as written", async () => {
    await openAtProject();
    expect(screen.getByRole("link", { name: "Issues" })).toHaveAttribute("href", "/forge/projects/hop/issues?tab=open");
    expect(screen.getByRole("link", { name: "Guides" })).toHaveAttribute("href", "https://forge.example.test/guides");
  });

  it("follows a plain click in the app, and leaves a modified click to the browser", async () => {
    const { router } = await openAtProject();
    const link = screen.getByRole("link", { name: "Issues" });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(router.state.location.pathname).toBe("/projects/hop");
    expect(fireEvent.click(link)).toBe(false);
    await expect.poll(() => router.state.location.href).toBe("/projects/hop/issues?tab=open");
  });

  it("loads an in-app link's page as the pointer or the focus reaches it, and leaves an outside one alone", async () => {
    const { router } = await openAtProject();
    const preload = vi.spyOn(router, "preloadRoute").mockResolvedValue(undefined);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "Issues" }));
    expect(preload).toHaveBeenCalledWith(expect.objectContaining({ href: "/projects/hop/issues?tab=open" }));
    // what it asks to load is the link's place, not the page it stands on
    const place = router.buildLocation(preload.mock.calls[0]?.[0] as Parameters<typeof router.buildLocation>[0]);
    expect(`${place.pathname}${place.searchStr}`).toBe("/projects/hop/issues?tab=open");
    preload.mockClear();
    fireEvent.focus(screen.getByRole("link", { name: "Issues" }));
    expect(preload).toHaveBeenCalledTimes(1);
    preload.mockClear();
    fireEvent.mouseEnter(screen.getByRole("link", { name: "Guides" }));
    fireEvent.focus(screen.getByRole("link", { name: "Guides" }));
    expect(preload).not.toHaveBeenCalled();
  });

  it("still follows the click when the page could not be loaded ahead", async () => {
    const { router } = await openAtProject();
    vi.spyOn(router, "preloadRoute").mockRejectedValue(new Error("chunk failed"));
    const link = screen.getByRole("link", { name: "Issues" });
    fireEvent.mouseEnter(link);
    fireEvent.click(link);
    await expect.poll(() => router.state.location.href).toBe("/projects/hop/issues?tab=open");
  });

  it("pushes a history entry, and replaces the current one", async () => {
    const { router } = await open();
    const entries = () => router.history.length;
    const before = entries();
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    await expect.poll(() => router.state.location.pathname).toBe("/projects/hop/requirements");
    expect(entries()).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await expect.poll(() => router.state.location.pathname).toBe("/projects/hop/feedback");
    expect(entries()).toBe(before + 1);
  });
});
