// @vitest-environment jsdom
//
// ISS-1229 r53, judge-165: New issue's refusal stood at the top of a form scrolled to its end, so at 1280x900
// pressing Create seemed to do nothing. The refusal stands beside Create, and says how long a 429 asks to wait.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

expect.extend(matchers);

const mutateAsync = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../hooks", () => ({ useCreateIssue: () => ({ mutateAsync, isPending: false, reset: vi.fn() }) }));
vi.mock("@uiw/react-codemirror", async () => (await import("@/test/codemirror-stub")).codeMirrorStub());

const { NewIssueDialog } = await import("./new-issue-dialog");

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

async function refusedCreate(err: unknown) {
  mutateAsync.mockRejectedValue(err);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { baseElement } = render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog open onClose={() => {}} scope={{ projectId: "p1", slug: "forge-dev" } as never} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "A refused create" } });
  fireEvent.submit(baseElement.querySelector("form") as HTMLFormElement);
  return screen.findByTestId("new-issue-refusal");
}

describe("New issue refused", () => {
  it("says the refusal beside Create, after every field and right before the button pressed", async () => {
    const refusal = await refusedCreate(new ApiError(500, "The tracker could not store the issue."));
    expect(refusal).toHaveTextContent("The tracker could not store the issue.");
    const create = screen.getByRole("button", { name: /Create issue/ });
    expect(refusal.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(refusal.parentElement?.contains(create)).toBe(true);
    for (const field of [screen.getByLabelText(/title/i)]) {
      expect(field.compareDocumentPosition(refusal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("brings the refusal and Create on screen together, so the button pressed is not scrolled away", async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });
    try {
      const refusal = await refusedCreate(new ApiError(500, "The tracker could not store the issue."));
      const create = screen.getByRole("button", { name: /Create issue/ });
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]?.contains(refusal)).toBe(true);
      expect(scrolled[0]?.contains(create)).toBe(true);
      // r54, judge-168: scrolled flush, Create sat on the screen's bottom edge at 390x600; it keeps the sheet's room.
      expect(scrolled[0]?.className).toContain("scroll-mb-[calc(1rem+env(safe-area-inset-bottom))]");
      expect(scrolled[0]?.closest(".overflow-y-auto")?.className).toContain("pb-[calc(1rem+env(safe-area-inset-bottom))]");
      // A form held to the sheet's height let its fields overflow past that room, so Create still met the edge.
      expect(scrolled[0]?.closest("form")?.className).not.toMatch(/(^|\s)h-full(\s|$)/);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("says how long a 429 asks to wait, in the server's own words", async () => {
    const said = "Too many requests in a short time. Try again in 30 seconds.";
    const refusal = await refusedCreate(new ApiError(429, said, "RATE_LIMITED", { retryAfterSeconds: 30 }, undefined, 30_000, false));
    expect(refusal).toHaveTextContent(said);
  });
});
