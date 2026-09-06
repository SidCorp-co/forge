/**
 * Pool admission writes `runners.status`, and exactly one route accepts it.
 * The project-scoped PATCH sits one line away in the same object and takes a
 * `.strict()` body of repoPath/branch/labels, so sending admission there is a
 * 400 the UI shows as a generic "Save failed" — which is how the toggle stayed
 * broken. These assert the URL, because the URL is the whole bug.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiClient = vi.fn().mockResolvedValue({});
vi.mock("@/lib/api/client", () => ({ apiClient: (e: string, o?: RequestInit) => apiClient(e, o) }));

const { runnersApi } = await import("./api");

const RUNNER = "6d49aba1-efec-478a-91d4-8f769a970f0f";
const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";

beforeEach(() => apiClient.mockClear());

describe("runnersApi.patchRunnerStatus", () => {
	it("PATCHes the top-level runner route, never the project-scoped one", async () => {
		await runnersApi.patchRunnerStatus(RUNNER, "draining");

		const [endpoint, options] = apiClient.mock.calls[0];
		expect(endpoint).toBe(`/runners/${RUNNER}`);
		expect(endpoint).not.toContain("/projects/");
		expect(options).toMatchObject({ method: "PATCH" });
		expect(JSON.parse(options.body)).toEqual({ status: "draining" });
	});
});

describe("runnersApi.patchRunner", () => {
	it("carries only what the project-scoped `.strict()` schema accepts", async () => {
		await runnersApi.patchRunner(PROJECT, RUNNER, { labels: ["release"] });

		const [endpoint, options] = apiClient.mock.calls[0];
		expect(endpoint).toBe(`/projects/${PROJECT}/runners/${RUNNER}`);
		expect(Object.keys(JSON.parse(options.body))).not.toContain("status");
	});
});
