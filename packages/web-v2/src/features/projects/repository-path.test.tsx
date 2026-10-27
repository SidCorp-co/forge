// @vitest-environment jsdom
//
// ISS-1236 r6, judge-140: the Repository path field said "Absolute path on the runner host where the
// repo is checked out", the meaning this issue removed. A person who filled it expected runs there.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsForm } from "@/design";
import type { ShapeDraft } from "@/features/project-settings/shape-form";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: null }) }));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: [] }) }));
vi.mock("@/features/project-settings/hooks", () => ({
  useUpdateProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("./hooks", () => ({
  useCreateProject: () => ({
    mutateAsync: async () => ({ id: "p1", slug: "desk", name: "Desk", orgId: "o1" }),
    reset: vi.fn(),
    isPending: false,
  }),
  useOnboardProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { RepositoryFields } = await import("@/features/project-settings/components/shape-sections");
const { NewProjectDialog } = await import("./components/new-project-dialog");

const SAYS = /offered when a device is bound to this project/;
const NEVER = /runner host where the repo is checked out/;

describe("the Repository path field says what the value is for", () => {
  it("in project settings", () => {
    const form = {
      draft: { repoPath: "/srv/app", repoUrl: "", baseBranch: "main" },
      setDraft: vi.fn(),
      errorAt: () => undefined,
    } as unknown as SettingsForm<ShapeDraft>;
    render(<RepositoryFields form={form} canEdit />);
    expect(screen.getByText(SAYS)).toBeInTheDocument();
    expect(screen.queryByText(NEVER)).not.toBeInTheDocument();
  });

  it("in the new-project dialog's second step", async () => {
    render(<NewProjectDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Desk" } });
    fireEvent.submit(screen.getByLabelText(/^Name/).closest("form") as HTMLFormElement);
    expect(await screen.findByText(SAYS)).toBeInTheDocument();
    expect(screen.queryByText(NEVER)).not.toBeInTheDocument();
  });
});
