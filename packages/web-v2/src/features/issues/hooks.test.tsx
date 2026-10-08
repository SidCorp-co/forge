// @vitest-environment jsdom
//
// ISS-1381 r4 — two clicks on Release now inside one frame both reached `mutate`, because the
// button's `disabled` waits for a render: the second POST was refused `CLAIM_CONFLICT` and the
// person saw "Batch release failed" beside "Batch release started".

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

/** Each release the server is asked for answers once the test says so. */
const answers: Array<(value: unknown) => void> = [];
const create = vi.fn(() => new Promise((resolve) => answers.push(resolve)));
const STARTED = { runId: "run-1", issueIds: ["iss-1"], warnings: [] };
async function answerAll() {
  await waitFor(() => expect(answers.length).toBeGreaterThan(0));
  await act(async () => {
    for (const answer of answers.splice(0)) answer(STARTED);
  });
}
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, releaseBatchApi: { ...actual.releaseBatchApi, create } };
});

const { useBatchRelease } = await import("./hooks");

afterEach(() => {
  cleanup();
  create.mockClear();
  toast.mockClear();
  answers.length = 0;
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("useBatchRelease — Release now pressed twice", () => {
  it("sends one release and shows the person no failure for the second press", async () => {
    const { result } = renderHook(() => useBatchRelease("proj-1"), { wrapper });

    act(() => {
      result.current.mutate({ issueIds: ["iss-1"] });
      result.current.mutate({ issueIds: ["iss-1"] });
    });
    await answerAll();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(create).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("sends again once the first release has answered", async () => {
    const { result } = renderHook(() => useBatchRelease("proj-1"), { wrapper });

    act(() => result.current.mutate({ issueIds: ["iss-1"] }));
    await answerAll();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.mutate({ issueIds: ["iss-2"] }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });
});
