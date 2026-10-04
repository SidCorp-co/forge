// The codes a device and the run sessions it opens are refused by, in the 422 envelope.

export const DEVICE_REFUSAL_CODES = [
	"DEVICE_REFUSED",
	"DEVICE_REVOKED",
	"RUN_SESSION_REFUSED",
	"RUNNER_NOT_ADMITTED",
	"WORKSPACE_HOLDER_REFUSED",
	"ISSUE_LEASE_AMBIGUOUS",
] as const;

export type DeviceRefusalCode = (typeof DEVICE_REFUSAL_CODES)[number];
