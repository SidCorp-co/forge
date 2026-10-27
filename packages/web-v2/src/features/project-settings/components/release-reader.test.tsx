// @vitest-environment jsdom
//
// Shape & release drew the caller's sentence for a check that could not run, so a person read
// "act on the ones carrying `evaluated: true`, and retry EVERY entry shaped like this one"
// (ISS-1229 r8, judge-20). Core sends both sentences; this screen draws the one a person reads.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseReadiness } from "../types";

expect.extend(matchers);

const readiness = vi.fn();
vi.mock("../hooks", async (importActual) => {
	const actual = await importActual<typeof import("../hooks")>();
	return { ...actual, useReleaseReadiness: () => readiness() };
});

const { ReleaseAnswer, ReleaseDetails } = await import("./release-section");

const CALLER =
	"One of the checks that decides whether a release may start could not be run. Act on the ones carrying `evaluated: true`, and retry EVERY entry shaped like this one.";
const READER =
	"Reading which issues wait at the release gate failed (timeout), so this answer cannot say whether a release would start. Load this page again to retry it.";

function answer(over: Partial<ReleaseReadiness>): ReleaseReadiness {
	return {
		hasReleaseGate: true,
		releaseChain: [{ branch: "main" }],
		releaseModel: "publish",
		releaseStrategy: null,
		baseBranch: "main",
		liveBranch: null,
		targetUndeclared: false,
		providers: ["coolify"],
		releaseRunnerLabel: "release-box",
		rollback: null,
		rollbackMode: null,
		hasVerify: true,
		declarationRead: true,
		channelsRead: true,
		blockers: [],
		warnings: [],
		gaps: [],
		...over,
	} as ReleaseReadiness;
}

function draw(data: ReleaseReadiness) {
	readiness.mockReturnValue({ isLoading: false, isError: false, data });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ReleaseAnswer projectId="p-1" slug="desk" />
			<ReleaseDetails projectId="p-1" />
		</QueryClientProvider>,
	);
}

afterEach(cleanup);

describe("a release reason on Shape & release", () => {
	it("is drawn as a person reads it, never as the caller's instruction", () => {
		const { container } = draw(
			answer({
				blockers: [
					{
						code: "RELEASE_CHECK_UNEVALUATED",
						evaluated: false,
						message: CALLER,
						reader: READER,
						details: { check: "roster", detail: "timeout" },
					},
				],
			}),
		);

		const text = container.textContent ?? "";
		expect(text).toContain("Load this page again to retry it.");
		expect(text).not.toMatch(/evaluated|EVERY/);
	});

	// ISS-1300 r4 (judge-121): the readiness page opened with the raw request a check failed on.
	// The sentence is the person's; the request sits folded under Technical details behind it.
	it("folds the request a check failed on under Technical details, out of the sentence", () => {
		const detail = "o/r could not read the head of main: GET /repos/o/r/commits/main on o/r returned HTTP 404";
		const { container, getByText } = draw(
			answer({
				blockers: [
					{
						code: "RELEASE_CHECK_UNEVALUATED",
						evaluated: false,
						message: "Forge cannot read o/r.",
						reader: "Reading which landings this release would carry beyond its issues failed: Forge cannot read o/r.",
						details: { check: "carried", detail, repository: "o/r", clears: "once Forge can read o/r again: x" },
					},
				],
			}),
		);

		const item = container.querySelector('[data-code="RELEASE_CHECK_UNEVALUATED"]');
		const summary = getByText("Technical details");
		expect(summary.closest("details")?.open).toBe(false);
		expect(summary.closest("details")?.textContent).toContain(detail);
		const sentence = item?.firstChild?.textContent ?? "";
		expect(sentence).not.toMatch(/GET \/repos|HTTP 404/);
	});

	it("adds no Technical details where the sentence already quotes the read", () => {
		const { queryByText } = draw(
			answer({
				blockers: [
					{
						code: "RELEASE_CHECK_UNEVALUATED",
						evaluated: false,
						message: CALLER,
						reader: READER,
						details: { check: "roster", detail: "timeout" },
					},
				],
			}),
		);
		expect(queryByText("Technical details")).toBeNull();
	});

	it("draws a warning as a person reads it too", () => {
		const { container } = draw(
			answer({
				warnings: [
					{
						code: "RELEASE_RUNNER_PREFERENCE_UNMET",
						message: "Or clear `releaseRunnerLabel` from the live deploy target.",
						reader: "Or clear the Release runner label from the live deploy target.",
					},
				],
			}),
		);

		const text = container.textContent ?? "";
		expect(text).toContain("clear the Release runner label from the live deploy target");
		expect(text).not.toContain("releaseRunnerLabel");
	});
});
