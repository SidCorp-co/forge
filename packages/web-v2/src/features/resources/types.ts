// web-v2 feature module: workspace Resources → Private Keys (ISS-628). Types
// re-exported from the shared contract — see `packages/contracts/src/ssh-keys.ts`.
export type {
	ProjectGitAccessView,
	SshConnTestResult,
	SshKeyCreateInput,
	SshKeyUsedByProject,
	WorkspaceSshKeyView,
} from "@forge/contracts";
