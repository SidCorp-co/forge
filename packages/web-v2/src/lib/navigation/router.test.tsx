// The app's navigation over TanStack Router (router.tsx), under a real router served from a base
// path: a link shows the browser the based href and is followed in-app, a modified click or an
// outside href is the browser's, and the hooks read the place without the base path.
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
