// The runners feature's reads: one key factory and its queryOptions. `['devices','me']`,
// `['devices','org']` and the project runner keys are the prefixes the WebSocket router invalidates
// (lib/ws/event-router.ts), so their shapes stay as they are; why each list also polls is on its hook.
import { queryOptions } from "@tanstack/react-query";
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
	myDevices: (orgId: string | null) =>
		queryOptions({ queryKey: runnerKeys.myDevices(orgId), queryFn: () => runnersApi.listDevices(orgId ?? undefined) }),
	orgDevices: (orgId: string | null) =>
		queryOptions({
			queryKey: runnerKeys.orgDevices(orgId),
			queryFn: () => runnersApi.listOrgDevices(orgId as string),
			enabled: !!orgId,
			refetchInterval: ORG_DEVICES_REFRESH_MS,
		}),
	deviceRunners: (deviceId: string | null) =>
		queryOptions({
			queryKey: runnerKeys.deviceRunners(deviceId),
			queryFn: () => runnersApi.listDeviceRunners(deviceId as string),
			enabled: !!deviceId,
		}),
	projectRunners: (projectId: string | null) =>
		queryOptions({
			queryKey: runnerKeys.projectRunners(projectId),
			queryFn: () => runnersApi.listProjectRunners(projectId as string),
			enabled: !!projectId,
			refetchInterval: 30_000,
		}),
	activity: (runnerId: string, enabled: boolean) =>
		queryOptions({ queryKey: runnerKeys.activity(runnerId), queryFn: () => runnersApi.getRunnerActivity(runnerId), enabled }),
	activeRunners: (projectId: string | null) =>
		queryOptions({
			queryKey: runnerKeys.activeRunners(projectId),
			queryFn: () => runnersApi.listActiveRunners(projectId as string),
			enabled: !!projectId,
			refetchInterval: 10_000,
		}),
};
