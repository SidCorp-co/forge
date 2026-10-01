// @vitest-environment jsdom
//
// A gate answered on the document must leave the Agents queue too: both list the same open question.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/features/questions/api", () => ({
	questionsApi: { answer: vi.fn(async () => ({ ok: true })) },
}));

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { gateQuestionKey, projectQuestionsKey, useAnswerProjectQuestion } = await import(
	"@/features/questions/hooks"
);
const { useAnswerGate } = await import("./hooks");

afterEach(cleanup);

it("refreshes the project's open questions, the gate and attention", async () => {
	const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const invalidated = vi.spyOn(qc, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useAnswerGate("p1"), { wrapper });
	act(() => result.current.mutate({ questionId: "q1", round: 1, optionId: "approve" }));
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	const keys = invalidated.mock.calls.map(([f]) => f?.queryKey);
	expect(keys).toContainEqual(projectQuestionsKey("p1"));
	expect(keys).toContainEqual(["ecosystem"]);
	expect(keys).toContainEqual(["attention"]);
});

it("is refreshed when the same question is answered from the Agents queue", async () => {
	const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const gate = gateQuestionKey("p1", "d1");
	qc.setQueryData(gate, { id: "q1" });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useAnswerProjectQuestion("p1"), { wrapper });
	act(() => result.current.mutate({ questionId: "q1", round: 1, optionId: "approve" }));
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(qc.getQueryState(gate)?.isInvalidated).toBe(true);
});
