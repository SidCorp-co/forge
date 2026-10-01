// @vitest-environment jsdom
//
// ISS-36 — one submit created ISS-35 and ISS-36 70 ms apart: the Create button only disables once
// `isPending` has re-rendered, so a second submit landing before that render posted again.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const mutateAsync = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../hooks", () => ({
  useCreateIssue: () => ({ mutateAsync, isPending: false, reset: vi.fn() }),
}));
vi.mock("@uiw/react-codemirror", async () => (await import("@/test/codemirror-stub")).codeMirrorStub());

const { NewIssueDialog } = await import("./new-issue-dialog");

const SCOPE = { projectId: "p1", slug: "forge-dev" } as never;

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog open onClose={() => {}} scope={SCOPE} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "posted once" } });
  return view.baseElement.querySelector("form") as HTMLFormElement;
}

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

describe("NewIssueDialog posts once per submit", () => {
  it("refuses a second submit fired in the same tick as the first", async () => {
    mutateAsync.mockReturnValue(new Promise(() => {}));
    const form = mount();
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
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
