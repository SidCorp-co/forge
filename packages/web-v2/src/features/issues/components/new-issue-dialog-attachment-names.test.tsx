// @vitest-environment jsdom
//
// ISS-963 — the server refuses a repeated attachment name and refuses the WHOLE batch when one
// member repeats, so the dialog staging two files under one name attached NEITHER while the toast
// said "Issue created". A clipboard screenshot is `image.png` every time, so that was one paste
// away. These pin the two halves of the fix: staging renames, and a create that still drops a file
// says which one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const toast = vi.fn();
const push = vi.fn();
const mutateAsync = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("../hooks", () => ({
  useCreateIssue: () => ({ mutateAsync, isPending: false, reset: vi.fn() }),
}));

const { NewIssueDialog } = await import("./new-issue-dialog");

const SCOPE = { projectId: "p1", slug: "forge-dev" } as never;

// cm:why BodyEditor fetches the component registry, so the tree needs a QueryClient even though nothing here asserts on it — without one every case fails on "No QueryClient set" rather than on the rule it is testing
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog open onClose={() => {}} scope={SCOPE} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  toast.mockReset();
  push.mockReset();
  mutateAsync.mockReset();
});

describe("NewIssueDialog attachment names (ISS-963)", () => {
  it("stages two pastes of one clipboard name under two names instead of one", () => {
    const { container } = mount();
    const form = container.querySelector("form") as HTMLFormElement;

    const paste = (name: string) => {
      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
        type: "image/png",
      });
      fireEvent.paste(form, {
        clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
      });
    };

    paste("image.png");
    paste("image.png");

    // cm:why both must survive under their OWN names — one shared name makes the server refuse the whole batch, so a test that only asserted "two chips" would pass while the user still lost both files
    expect(screen.getByTitle("image.png")).toBeInTheDocument();
    expect(screen.getByTitle("image-2.png")).toBeInTheDocument();
    expect(screen.getByText(/Renamed image\.png to image-2\.png/)).toBeInTheDocument();
  });

  it("reports the files a create dropped instead of reporting success", async () => {
    mutateAsync.mockResolvedValue({
      id: "i1",
      displayId: "ISS-1",
      attachmentErrors: [
        { index: 1, name: "notes.log", code: "ATTACHMENT_NAME_TAKEN", message: "already on this issue" },
      ],
    });

    const { container } = mount();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "has a dropped file" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0]?.[0];
    expect(arg.tone).toBe("error");
    expect(arg.title).toMatch(/not attached/);
    expect(arg.description).toMatch(/notes\.log/);
  });

  it("gives each dropped file its own reason, in words a person can act on", async () => {
    mutateAsync.mockResolvedValue({
      id: "i3",
      displayId: "ISS-3",
      attachmentErrors: [
        {
          index: 0,
          name: "shot.png",
          code: "ATTACHMENT_NAME_TAKEN",
          message: 'an attachment named "shot.png" is already on this issue (id 9f1e…) — cite it',
        },
        { index: 1, name: "big.mp4", code: "FILE_TOO_LARGE", message: "file too large" },
      ],
    });

    const { container } = mount();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "two reasons" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const { description } = toast.mock.calls[0]?.[0] ?? {};
    expect(description).toContain("shot.png — this issue already has a file with that name");
    expect(description).toContain("big.mp4 — too large");
    expect(description).not.toMatch(/cite it|id 9f1e/);
  });

  it("stages a name that only collides once sanitised under a name of its own", () => {
    const { container } = mount();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const pick = (name: string) =>
      fireEvent.change(input, {
        target: { files: [new File([new Uint8Array([0x89, 0x50])], name, { type: "image/png" })] },
      });

    pick("a_b.png");
    pick("a b.png");

    // cm:why the server sanitises before it compares, so `a b.png` and `a_b.png` are ONE name there — staging both unchanged loses the whole batch to a collision the dialog never saw
    expect(screen.getByTitle("a_b.png")).toBeInTheDocument();
    expect(screen.getByTitle("a b-2.png")).toBeInTheDocument();
  });

  it("still reports plain success when nothing was dropped", async () => {
    mutateAsync.mockResolvedValue({ id: "i2", displayId: "ISS-2" });

    const { container } = mount();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "clean create" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0]?.[0];
    expect(arg.tone).toBe("success");
    expect(arg.title).toBe("Issue created");
  });
});
