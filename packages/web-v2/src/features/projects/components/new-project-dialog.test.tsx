// @vitest-environment jsdom
//
// ISS-36 — the same race as the New issue dialog: a second submit landing before `isPending`
// re-renders posted the project twice, and the second post came back SLUG_TAKEN on the slug the
// first had just created.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const mutateAsync = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: [] }) }));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: null }) }));
vi.mock("../hooks", () => ({
  useCreateProject: () => ({ mutateAsync, isPending: false, reset: vi.fn() }),
  useOnboardProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { NewProjectDialog } = await import("./new-project-dialog");

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

function mount() {
  const view = render(<NewProjectDialog open onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Posted once" } });
  return view.baseElement.querySelector("form") as HTMLFormElement;
}

describe("NewProjectDialog posts once per submit", () => {
  it("refuses a second submit fired in the same tick as the first", async () => {
    mutateAsync.mockReturnValue(new Promise(() => {}));
    const form = mount();
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("lets the person submit again after a create that failed", async () => {
    mutateAsync.mockRejectedValueOnce(new Error("core is down"));
    const form = mount();
    fireEvent.submit(form);
    await screen.findByText(/core is down/);
    mutateAsync.mockReturnValue(new Promise(() => {}));
    fireEvent.submit(form);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
  });
});
