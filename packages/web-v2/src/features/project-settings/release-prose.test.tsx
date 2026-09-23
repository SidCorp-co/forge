// @vitest-environment jsdom
//
// The sentence a person reads, not the sentence the API answers with. The
// release blockers are authored as markdown so an API caller gets code spans,
// and this screen rendered them as plain text — so "at `testing`" and "sending
// it as `null`" arrived with their backticks, and the first thing a reader's
// eye caught was the authoring (ISS-1127). The same tab also labelled a
// draining box `offline` while a blocker on it called the same box up and
// reporting, which is two accounts of one box on one screen.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRunner } from "@/features/runners/types";
import type { ReleaseReadiness } from "./types";

expect.extend(matchers);

const readiness = vi.fn();
vi.mock("./hooks", async (importActual) => {
	const actual = await importActual<typeof import("./hooks")>();
	return { ...actual, useReleaseReadiness: () => readiness() };
});

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

const projectRunners = vi.fn();
vi.mock("@/features/runners/hooks", async (importActual) => {
	const actual = await importActual<typeof import("@/features/runners/hooks")>();
	return { ...actual, useProjectRunners: () => projectRunners() };
});

const { ReleaseSection } = await import("./components/release-section");
const { RunnerPoolsSection } = await import("./components/runner-pools-section");

function draw(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

function ready(over: Partial<ReleaseReadiness>): ReleaseReadiness {
	return {
		hasReleaseGate: true,
		releaseModel: "publish",
		releaseStrategy: null,
		baseBranch: "main",
		liveBranch: null,
		targetUndeclared: false,
		providers: ["coolify"],
		releaseRunnerLabel: "release",
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

function runner(over: Partial<ProjectRunner>): ProjectRunner {
	return {
		runnerId: "r-1",
		deviceId: "d-1",
		deviceName: "dev1",
		platform: "linux",
		deviceStatus: "online",
		agentVersion: "0.17.1",
		deviceDisabledAt: null,
		runnerStatus: "online",
		lastError: null,
		limitReason: null,
		rateLimitedUntil: null,
		limitDetail: null,
		repoPath: null,
		branch: null,
		labels: [],
		lastSeenAt: new Date().toISOString(),
		provisionStatus: "ready",
		provisionDetail: null,
		provisionedAt: null,
		...over,
	} as ProjectRunner;
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
});

describe("the Runner pools matrix", () => {
	it("calls a draining box out of the pool, not offline, because it is up", () => {
		projectRunners.mockReturnValue({
			data: [runner({ runnerStatus: "draining" })],
			isLoading: false,
		});

		draw(<RunnerPoolsSection projectId={PROJECT_ID} config={{}} canEdit={false} />);

		expect(screen.getByText("out of the pool")).toBeInTheDocument();
		expect(screen.queryByText("offline")).toBeNull();
	});

	it("says the same of a disabled box", () => {
		projectRunners.mockReturnValue({
			data: [runner({ runnerStatus: "disabled" })],
			isLoading: false,
		});

		draw(<RunnerPoolsSection projectId={PROJECT_ID} config={{}} canEdit={false} />);

		expect(screen.getByText("out of the pool")).toBeInTheDocument();
	});

	it("still says offline of a box whose device is not online", () => {
		projectRunners.mockReturnValue({
			data: [runner({ deviceStatus: "offline", runnerStatus: "offline" })],
			isLoading: false,
		});

		draw(<RunnerPoolsSection projectId={PROJECT_ID} config={{}} canEdit={false} />);

		expect(screen.getByText("offline")).toBeInTheDocument();
		expect(screen.queryByText("out of the pool")).toBeNull();
	});
});
