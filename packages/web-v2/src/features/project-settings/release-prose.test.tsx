// @vitest-environment jsdom
//
// The sentence a person reads, not the sentence the API answers with. The
// release blockers are authored as markdown so an API caller gets code spans,
// and this screen rendered them as plain text — so "at `testing`" and "sending
// it as `null`" arrived with their backticks, and the first thing a reader's
// eye caught was the authoring (ISS-1127).

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseReadiness } from "./types";

expect.extend(matchers);

const readiness = vi.fn();
vi.mock("./hooks", async (importActual) => {
	const actual = await importActual<typeof import("./hooks")>();
	return { ...actual, useReleaseReadiness: () => readiness() };
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));


const { ReleaseSection } = await import("./components/release-section");

function draw(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

function ready(over: Partial<ReleaseReadiness>): ReleaseReadiness {
	return {
		hasReleaseGate: true,
		defaultBranch: "main",
		production: {
			environment: "production",
			deploysFrom: null,
			bindingId: "66666666-6666-4666-8666-666666666666",
			trigger: "on-request",
		},
		promotions: [],
		targetUndeclared: false,
		targetUndeclaredReason: null,
		providers: ["coolify"],
		releaseRunnerLabel: "release",
		rollback: null,
		rollbackMode: null,
		hasVerify: true,
		verifySources: ["environment"],
		declarationRead: true,
		channelsRead: true,
		blockers: [],
		warnings: [],
		gaps: [],
		...over,
	} as ReleaseReadiness;
}


afterEach(cleanup);

describe("the Release section's prose", () => {
	it("renders a code span as code, so no reader meets a backtick", () => {
		readiness.mockReturnValue({
			isLoading: false,
			error: null,
			data: ready({
				blockers: [
					{
						code: "RELEASE_ROSTER_EMPTY",
						evaluated: true,
						message: "Nothing waits at `awaiting_release`, and 3 stand at `testing`.",
					},
				],
			}),
		});

		const { container } = draw(<ReleaseSection projectId={PROJECT_ID} />);

		expect(container.textContent).not.toContain("`");
		expect([...container.querySelectorAll("code")].map((n) => n.textContent)).toEqual([
			"awaiting_release",
			"testing",
		]);
	});

	it("renders a warning's code spans the same way, not only a blocker's", () => {
		readiness.mockReturnValue({
			isLoading: false,
			error: null,
			data: ready({
				warnings: [
					{
						code: "RELEASE_RUNNER_PREFERENCE_UNMET",
						message: "No box carries `release`.",
					},
				],
			}),
		});

		const { container } = draw(<ReleaseSection projectId={PROJECT_ID} />);

		expect(container.textContent).not.toContain("`");
		expect([...container.querySelectorAll("code")].map((n) => n.textContent)).toEqual([
			"release",
		]);
	});

	it("leaves an unpaired backtick as the character it is rather than eating the rest", () => {
		readiness.mockReturnValue({
			isLoading: false,
			error: null,
			data: ready({
				blockers: [
					{
						code: "RELEASE_POOL_EMPTY",
						evaluated: true,
						message: "A stray ` and then some words that must survive it.",
					},
				],
			}),
		});

		const { container } = draw(<ReleaseSection projectId={PROJECT_ID} />);

		expect(container.textContent).toContain("and then some words that must survive it.");
		expect(container.querySelector("code")).toBeNull();
	});

	// `Rollback` and `Deploy verified by` each say what follows from their own
	// absence; this row said `—`, on the card about the question ISS-1275 was
	// filed on — whether no release runner label is settled or outstanding.
	it("says what follows from no release runner label, rather than an em dash", () => {
		readiness.mockReturnValue({
			isLoading: false,
			error: null,
			data: ready({ releaseRunnerLabel: null }),
		});

		draw(<ReleaseSection projectId={PROJECT_ID} />);

		expect(
			screen.getByText("none — a release goes to any box in this project's pool"),
		).toBeInTheDocument();
		expect(screen.queryByText("—")).toBeNull();
	});

	it("shows the declared label itself where the project declares one", () => {
		readiness.mockReturnValue({
			isLoading: false,
			error: null,
			data: ready({ releaseRunnerLabel: "release" }),
		});

		draw(<ReleaseSection projectId={PROJECT_ID} />);

		expect(screen.getByText("release")).toBeInTheDocument();
		expect(
			screen.queryByText("none — a release goes to any box in this project's pool"),
		).toBeNull();
	});

	// ISS-1321 took the probe out of the gate: a release with none runs and closes unverified.
	it("says a release with no verify probe closes unverified, not that it is refused", () => {
		readiness.mockReturnValue({
			isLoading: false,
			error: null,
			data: ready({ hasVerify: false, gaps: ["verify-probes"] }),
		});

		const { container } = draw(<ReleaseSection projectId={PROJECT_ID} />);

		expect(container.textContent).toMatch(/closes unverified/i);
		expect(container.textContent).not.toMatch(/refused/i);
	});
});
