// @vitest-environment jsdom
//
// ISS-1391 — a project that ships by version tag declares the tag in the last entry of its release
// chain, and this screen has no field for it. What it can still do is lose it: the chain is rebuilt
// from the screen's own fields on every save, so a `tag` it did not hand back would be dropped in
// silence and the project would go back to closing issues no tag carries. These cases read what the
// screen puts on the wire, because that is the half that was at risk.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";
import { RepoTab } from "./components/repo-tab";
import type { ReleaseChainEntry } from "./types";

expect.extend(matchers);

/** Every PATCH body the screen put on the wire, in order. */
let sent: Array<Record<string, unknown>>;

vi.mock("@/lib/api/client", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
	return {
		...actual,
		apiClient: async (_path: string, init?: { method?: string; body?: string }) => {
			if (init?.method === "PATCH") sent.push(JSON.parse(init.body ?? "{}"));
			return {};
		},
	};
});

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

beforeEach(() => {
	sent = [];
});
afterEach(cleanup);

function project(releaseChain: ReleaseChainEntry[], baseBranch = "dev"): ProjectDetail {
	return {
		id: "p1",
		repoPath: "/srv/desk",
		baseBranch,
		releaseChain,
	} as unknown as ProjectDetail;
}

function show(p: ProjectDetail) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<RepoTab project={p} canEdit />
		</QueryClientProvider>,
	);
}

const save = () => screen.getByRole("button", { name: "Save repository" });
const type = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the repository tab hands back the release tag it shows no field for (criterion 14)", () => {
	it("sends no chain at all where only the repository path changed", async () => {
		show(project([{ branch: "dev", tag: "v*.*.*" }]));

		type("Repository path", "/srv/desk2");
		fireEvent.click(save());

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ repoPath: "/srv/desk2" });
	});

	it("keeps the tag on the first entry when the base branch moves and the chain goes up with it", async () => {
		show(project([{ branch: "dev", tag: "v*.*.*" }]));

		type("Base branch", "main");
		fireEvent.click(save());

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({
			baseBranch: "main",
			releaseChain: [{ branch: "main", tag: "v*.*.*" }],
		});
	});

	it("moves the tag to the new last entry when a branch is added below it", async () => {
		show(project([{ branch: "dev", tag: "v*" }]));

		fireEvent.click(screen.getByRole("button", { name: "Add a branch" }));
		type("2. Branch", "production");
		fireEvent.click(save());

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({
			releaseChain: [{ branch: "dev" }, { branch: "production", from: "merge-branch", tag: "v*" }],
		});
	});

	it("keeps the tag on the last entry of a chain it did not edit, when the base branch moves", async () => {
		show(
			project([
				{ branch: "dev" },
				{ from: "merge-branch", branch: "main", tag: "v*" } as ReleaseChainEntry,
			]),
		);

		type("Base branch", "trunk");
		fireEvent.click(save());

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.releaseChain).toEqual([
			{ branch: "trunk" },
			{ branch: "main", from: "merge-branch", tag: "v*" },
		]);
	});

	it("is not dirty for a chain the server answered with its keys in another order", () => {
		show(project([{ branch: "dev" }, { from: "merge-branch", branch: "main" } as ReleaseChainEntry]));

		expect(save()).toBeDisabled();
	});

	it("puts no tag on the wire for a project that declared none", async () => {
		show(project([{ branch: "dev" }]));

		type("Base branch", "main");
		fireEvent.click(save());

		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ baseBranch: "main", releaseChain: [{ branch: "main" }] });
	});
});
