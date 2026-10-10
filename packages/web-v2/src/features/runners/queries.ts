// The runners feature's reads: one key factory and its queryOptions. `['devices','me']`,
// `['devices','org']` and the project runner keys are the prefixes the WebSocket router invalidates
// (lib/ws/event-router.ts), so their shapes stay as they are; why each list also polls is on its hook.
import { readOf } from "@/lib/api/query-kit";
import { runnersApi } from "./api";

export const ORG_DEVICES_REFRESH_MS = 30_000;

export const runnerKeys = {
	devices: ["devices"] as const,
	myDevicesAll: () => [...runnerKeys.devices, "me"] as const,
	myDevices: (orgId: string | null) => [...runnerKeys.myDevicesAll(), orgId] as const,
	orgDevices: (orgId: string | null) => [...runnerKeys.devices, "org", orgId] as const,
	deviceRunners: (deviceId: string | null) => [...runnerKeys.devices, deviceId, "runners"] as const,
	projectRunners: (projectId: string | null) => ["projects", projectId, "runners"] as const,
	activeRunners: (projectId: string | null) => ["projects", projectId, "active-runners"] as const,
	runners: ["runners"] as const,
	activity: (runnerId: string) => [...runnerKeys.runners, runnerId, "activity"] as const,
};

export const runnerQueries = {
	myDevices: (orgId: string | null) => ({ ...readOf(runnerKeys.myDevices(orgId), () => runnersApi.listDevices(orgId ?? undefined), 0), enabled: true }),
	orgDevices: (orgId: string | null) => ({ ...readOf(runnerKeys.orgDevices(orgId), () => runnersApi.listOrgDevices(orgId as string), 0), refetchInterval: ORG_DEVICES_REFRESH_MS }),
	deviceRunners: (deviceId: string | null) => readOf(runnerKeys.deviceRunners(deviceId), () => runnersApi.listDeviceRunners(deviceId as string), 0),
	projectRunners: (projectId: string | null) => ({ ...readOf(runnerKeys.projectRunners(projectId), () => runnersApi.listProjectRunners(projectId as string), 0), refetchInterval: 30_000 }),
	activity: (runnerId: string, enabled: boolean) => ({ ...readOf(runnerKeys.activity(runnerId), () => runnersApi.getRunnerActivity(runnerId), 0), enabled }),
	activeRunners: (projectId: string | null) => ({ ...readOf(runnerKeys.activeRunners(projectId), () => runnersApi.listActiveRunners(projectId as string), 0), refetchInterval: 10_000 }),
};
