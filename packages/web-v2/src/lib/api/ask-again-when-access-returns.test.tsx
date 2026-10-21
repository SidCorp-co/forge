// @vitest-environment jsdom
//
// ISS-1228 r27 (judge-85's note under 233, criterion 270): a member removed from the project and
// added back pressed the header's Retry; the issue, its run and its session answered, while Cost,
// Relations and the attachments went on saying "Not a project member" until each one's own Retry.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { type PageRead, useAskAgainWhenAccessReturns } from "./ask-again-when-access-returns";

const forbidden = new ApiError(403, "Not a project member.", "FORBIDDEN");

const refused = (): PageRead => ({ isError: true, error: forbidden, refetch: vi.fn() });
const answered = (): PageRead => ({ isError: false, error: null, refetch: vi.fn() });

describe("a page whose reads Forge refused for not being a member", () => {
	it("asks every other refused read again once one of them answers, letting one in flight finish", () => {
		const [issue, cost, deps] = [refused(), refused(), refused()];
		const hook = renderHook(({ reads }) => useAskAgainWhenAccessReturns(reads), {
			initialProps: { reads: [issue, cost, deps] },
		});
		expect(cost.refetch).not.toHaveBeenCalled();

		const back = answered();
		hook.rerender({ reads: [back, cost, deps] });
		expect(cost.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
		expect(deps.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
		expect(back.refetch).not.toHaveBeenCalled();
	});

	it("asks nothing again while every refusal stands, or when a refused read fails some other way", () => {
		const [issue, cost] = [refused(), refused()];
		const hook = renderHook(({ reads }) => useAskAgainWhenAccessReturns(reads), {
			initialProps: { reads: [issue, cost] },
		});
		hook.rerender({ reads: [issue, cost] });
		const unreachable: PageRead = { isError: true, error: new ApiError(503, "Forge is restarting.", "UNAVAILABLE"), refetch: vi.fn() };
		hook.rerender({ reads: [unreachable, cost] });
		expect(cost.refetch).not.toHaveBeenCalled();
	});

	// Review F2: a 503 between the refusal and the answer dropped the refusal from memory.
	it("still asks the others again when the refused read failed some other way before it answered", () => {
		const cost = refused();
		const hook = renderHook(({ reads }) => useAskAgainWhenAccessReturns(reads), {
			initialProps: { reads: [refused(), cost] },
		});
		const unreachable: PageRead = { isError: true, error: new ApiError(503, "Forge is restarting.", "UNAVAILABLE"), refetch: vi.fn() };
		hook.rerender({ reads: [unreachable, cost] });
		expect(cost.refetch).not.toHaveBeenCalled();
		hook.rerender({ reads: [answered(), cost] });
		expect(cost.refetch).toHaveBeenCalledTimes(1);
		expect(cost.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
	});

	it("asks nothing when no read had been refused", () => {
		const read = answered();
		const hook = renderHook(({ reads }) => useAskAgainWhenAccessReturns(reads), {
			initialProps: { reads: [read, refused()] },
		});
		hook.rerender({ reads: [read, read] });
		expect(read.refetch).not.toHaveBeenCalled();
	});
});
