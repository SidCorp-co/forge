// REQ-34 BC-2, BC-18: setting several issues' status at once moves each through its own status move,
// so a draft the issue-ready checklist holds back is refused there as it is on its own page. The
// bulk apply names each issue it skipped with core's own words, never only a count.

import { ISSUE_READY_CHECKLIST } from "@forge/contracts/checklist-registry";
import { checklistRefusals, evaluateChecklist } from "@forge/contracts/checklists";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore } from "@/test/render";
import { useBulkUpdateIssues } from "./hooks";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

const GAPS = checklistRefusals(
  evaluateChecklist(ISSUE_READY_CHECKLIST, {
    given: {},
    record: {
      requirement: { gap: "The issue is not linked to a requirement.", fix: "Link it, then write its plan." },
      criteria: { gap: "The issue has no acceptance criteria.", fix: "Write its numbered acceptance criteria." },
      design: { value: "None: it builds no workflow design." },
    },
  }),
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => toast.mockReset());

describe("a bulk status change", () => {
  it("names each issue it could not move with core's words for why", async () => {
    fakeCore((call) => {
      if (call.path === "/issues/i1/transition") return { body: { id: "i1", status: "open" } };
      const code = "CHECKLIST_INCOMPLETE";
      return { status: 422, body: { error: { code, message: "refused, nothing written", refusals: GAPS } } };
    });
    const { result } = renderHook(() => useBulkUpdateIssues(), { wrapper });
    act(() =>
      result.current.mutate({
        issues: [
          { id: "i1", displayId: "ISS-1" },
          { id: "i2", displayId: "ISS-2" },
        ],
        update: { kind: "status", toStatus: "open" },
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const shown = toast.mock.calls[0]?.[0] as { title: string; description?: string };
    expect(shown.title).toBe("1 updated · 1 skipped");
    expect(shown.description).toBe(`ISS-2 was not moved: ${GAPS.map((g) => g.detail).join(" ")}`);
    expect(shown.description).not.toMatch(/CHECKLIST_|requirementId|acceptanceCriteria/);
  });
});
