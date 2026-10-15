// @vitest-environment jsdom
//
// The link beside a release sentence is how a person goes to find what stops the release, so it
// opens the statuses that sentence counts. Judge j16 followed "Open the issues at Awaiting release"
// from a sentence counting one issue at Testing and landed on an empty list (ISS-1229).

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseReadiness } from "../types";

expect.extend(matchers);

const readiness = vi.fn();
vi.mock("../hooks", async (importActual) => {
	const actual = await importActual<typeof import("../hooks")>();
	return { ...actual, useReleaseReadiness: () => readiness() };
});

const { ReleaseAnswer } = await import("./release-section");

function blockedBy(blocker: ReleaseReadiness["blockers"][number]): ReleaseReadiness {
	return {
		hasReleaseGate: true,
		releaseChain: [{ branch: "main" }],
		releaseModel: "publish",
		releaseStrategy: null,
		baseBranch: "main",
		liveBranch: null,
		targetUndeclared: false,
		providers: ["coolify"],
		releaseRunnerLabel: null,
		rollback: null,
		rollbackMode: null,
		hasVerify: true,
		declarationRead: true,
		channelsRead: true,
		blockers: [blocker],
		warnings: [],
		gaps: [],
	} as ReleaseReadiness;
}

function drawWith(blocker: ReleaseReadiness["blockers"][number]) {
	readiness.mockReturnValue({ isLoading: false, isError: false, data: blockedBy(blocker) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ReleaseAnswer projectId="p-1" slug="desk" />
		</QueryClientProvider>,
	);
}

function issueLinks(container: HTMLElement): { text: string; href: string | null }[] {
	return [...container.querySelectorAll("li a")].map((a) => ({
		text: a.textContent ?? "",
		href: a.getAttribute("href"),
	}));
}

afterEach(cleanup);

describe("the issue link beside a release sentence opens what that sentence counts", () => {
	it("opens Testing and Tested where the sentence counts issues near the gate", () => {
		const { container } = drawWith({
			code: "RELEASE_ROSTER_EMPTY",
			evaluated: true,
			message:
				"Nothing is ready to release: 1 issue is at Testing or Tested, and each moves to Awaiting release once it records where its change now runs.",
			details: { nearGate: 1 },
		});

		expect(issueLinks(container)).toEqual([
			{
				text: "Open the issues at Testing or Tested",
				href: "/projects/desk/issues?status=testing,tested",
			},
		]);
	});

	it("offers no issue link where the sentence counts no issue at any status", () => {
		const { container } = drawWith({
			code: "RELEASE_ROSTER_EMPTY",
			evaluated: true,
			message: "Nothing is ready to release: no issue is at Testing, Tested or Awaiting release.",
			details: { nearGate: 0 },
		});

		expect(screen.getByText(/no issue is at Testing, Tested or Awaiting release/)).toBeInTheDocument();
		expect(issueLinks(container)).toEqual([]);
	});

	it("offers no issue link where the roster is empty and nothing says what is near it", () => {
		const { container } = drawWith({
			code: "RELEASE_ROSTER_EMPTY",
			evaluated: true,
			message: "Nothing is ready to release: no issue is at Awaiting release.",
		});

		expect(issueLinks(container)).toEqual([]);
	});

	it("still opens Awaiting release where the sentence is about the issues waiting there", () => {
		const { container } = drawWith({
			code: "RELEASE_CRITERIA_UNEARNED",
			evaluated: true,
			message:
				"Every issue at Awaiting release still owes a verdict on an acceptance criterion, so the automatic release cuts nothing until each is recorded: `ISS-4` owes criteria 1–3.",
		});

		expect(issueLinks(container)).toEqual([
			{
				text: "Open the issues at Awaiting release",
				href: "/projects/desk/issues?status=awaiting_release",
			},
		]);
	});
});
