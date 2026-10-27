// @vitest-environment jsdom
//
// ISS-1236 r7, judge-144 at ae528e1: the new-project dialog creates the project, then saves its
// repository settings. When that second write was refused, a toast titled "The project was not saved"
// stood over a project that had been saved, inviting a second create into a taken slug.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

expect.extend(matchers);
afterEach(cleanup);

const toast = vi.fn();
const update = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: null }) }));
vi.mock("@/features/orgs/hooks", () => ({
  useOrgs: () => ({ data: [], isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/features/project-settings/api", () => ({ projectSettingsApi: { update } }));
vi.mock("../hooks", () => ({
  useCreateProject: () => ({
    mutateAsync: async () => ({ id: "p1", slug: "desk", name: "Desk", orgId: null }),
    reset: vi.fn(),
    isPending: false,
  }),
  useOnboardProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { NewProjectDialog } = await import("./new-project-dialog");

const REFUSAL =
  "repoPath must be an absolute path on the device (it starts with /), not ~/code/app — a relative path names a different directory on every box.";

async function createThenSaveRepository(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NewProjectDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Desk" } });
  fireEvent.submit(screen.getByLabelText(/^Name/).closest("form") as HTMLFormElement);
  const field = await screen.findByLabelText(/^Repository path/);
  fireEvent.change(field, { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "Save repository settings" }));
}

const titles = () => toast.mock.calls.map(([t]) => (t as { title: string }).title);

beforeEach(() => {
  toast.mockClear();
  update.mockReset();
});

describe("the new-project dialog when its repository step is refused", () => {
  it("never says the project was not saved", async () => {
    update.mockRejectedValue(new ApiError(400, REFUSAL, "REPO_PATH_NOT_ABSOLUTE"));
    await createThenSaveRepository("~/code/app");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(titles()).not.toContain("The project was not saved");
  });

  it("says the project was created, what was not saved, and where to set it", async () => {
    update.mockRejectedValue(new ApiError(400, REFUSAL, "REPO_PATH_NOT_ABSOLUTE"));
    await createThenSaveRepository("~/code/app");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    const said = toast.mock.calls[1]?.[0] as { title: string; description: string; tone: string };
    expect(said.title).toBe("Project created; its repository settings were not saved");
    expect(said.description).toContain(REFUSAL);
    expect(said.description).toContain("Settings, under Repository");
    expect(said.tone).toBe("error");
    expect(screen.getByText(REFUSAL)).toBeInTheDocument();
  });

  it("says a fault the same way, the project still created", async () => {
    update.mockRejectedValue(new ApiError(503, "The server is down"));
    await createThenSaveRepository("/srv/desk");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(titles()[1]).toBe("Project created; its repository settings were not saved");
    expect((toast.mock.calls[1]?.[0] as { description: string }).description).toMatch(
      /\. Set them in the project's Settings, under Repository\.$/,
    );
  });

  it("still says the settings were saved when the step is accepted", async () => {
    update.mockResolvedValue({});
    await createThenSaveRepository("/srv/desk");
    expect(await screen.findByText("Repository settings saved.")).toBeInTheDocument();
    expect(titles()).toEqual(["Project created", "Project saved"]);
  });
});
