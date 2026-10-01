// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = (data: unknown = undefined) => ({
	data,
	isLoading: false,
	isError: false,
	error: null,
	refetch: vi.fn(),
});
const mutation = () => ({ mutate: vi.fn(), isPending: false, data: undefined });

let projectDocument: unknown = null;

vi.mock("../hooks", () => ({
	useActiveRunners: () => query({ runners: [] }),
	useAssignDeviceToProject: mutation,
	useClearRunnerError: mutation,
	useDeleteGitCredential: mutation,
	useDevices: () => query([]),
	useGitCredential: () => query({ configured: false }),
	useInitPairing: mutation,
	useProjectRunners: () => query([]),
	useReprovision: mutation,
	useRunnerActivity: () => query([]),
	useSetDeviceDisabled: mutation,
	useSetGitCredential: mutation,
	useTestGitCredential: mutation,
	useUnassignDeviceFromProject: mutation,
}));
vi.mock("@/features/projects/hooks", () => ({
	useProject: () => query({ id: "p-1", slug: "forge-dev", orgId: "org-1" }),
}));
vi.mock("@/features/project-settings/config-hooks", () => ({
	useProjectDocument: () => query(projectDocument),
}));
vi.mock("@/features/resources/hooks", () => ({ useOrgSshKeys: () => query([]) }));
vi.mock("@/features/resources/components/private-key-create-slideover", () => ({
	PrivateKeyCreateSlideOver: () => null,
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

const { ProjectRunnersScreen } = await import("./project-runners-screen");

function declaring(repository: string | null) {
	projectDocument = {
		declared: true,
		revision: 3,
		document: {
			source: repository
				? { type: "git", git: { repository, defaultBranch: "main", branches: ["main"] } }
				: { type: "none" },
		},
	};
}

beforeEach(() => {
	projectDocument = null;
});

afterEach(() => {
	cleanup();
});

describe("ProjectRunnersScreen git access (ISS-16)", () => {
	it("shows the repository the project document declares, read-only, and links to where it is edited", () => {
		declaring("github.com/SidCorp-co/forge");
		render(<ProjectRunnersScreen projectId="p-1" canEdit embedded />);

		expect(screen.getByText("github.com/SidCorp-co/forge")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Edit in Configuration" }).getAttribute("href")).toBe(
			"/projects/forge-dev/settings?tab=config",
		);
		expect(screen.queryByPlaceholderText("git@github.com:org/repo.git")).toBeNull();
		expect(screen.queryByText("Repo URL")).toBeNull();
		expect(screen.queryByText("Workspace setup")).toBeNull();
		expect(screen.queryByText(/declares no repository, so a device/)).toBeNull();
	});

	it("says the configuration declares no repository, and warns before a device is assigned", () => {
		declaring(null);
		render(<ProjectRunnersScreen projectId="p-1" canEdit embedded />);

		expect(screen.getByText(/configuration declares no repository\.$/)).toBeTruthy();
		expect(screen.getByText(/declares no repository, so a device/)).toBeTruthy();
	});

	it("reads a project with no document at all as declaring no repository", () => {
		projectDocument = { declared: false, revision: null, document: null };
		render(<ProjectRunnersScreen projectId="p-1" canEdit embedded />);

		expect(screen.getByText(/declares no repository, so a device/)).toBeTruthy();
	});
});
