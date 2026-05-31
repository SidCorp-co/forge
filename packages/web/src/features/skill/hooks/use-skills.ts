import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { deviceApi } from '@/features/device/api';
import { skillApi, skillRegistrationApi } from '../api';
import type { Skill, SkillFile } from '../types';

export function useSkills(projectDocumentId?: string) {
  return useQuery({
    queryKey: ['skills', projectDocumentId],
    queryFn: () => skillApi.getAll(projectDocumentId),
    enabled: !!projectDocumentId,
  });
}

export function useSkill(documentId: string) {
  return useQuery({
    queryKey: ['skill', documentId],
    queryFn: () => skillApi.getOne(documentId),
    enabled: !!documentId,
  });
}

// The project skills page lists from `useEffectiveSkills` (key
// `['skills-effective', projectId]`), which merges the global skills
// catalog with per-project overrides. Mutations that touch the global
// catalog must invalidate BOTH `['skills']` (global list cache, used by
// the standalone /skills admin) AND `['skills-effective']` (project list
// cache) so the project page reflects the change immediately. Missing
// the latter is what made create/update/delete look like silent no-ops
// on the project skills page.

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof skillApi.create>[0]) => skillApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skills-effective'] });
    },
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ documentId, data }: { documentId: string; data: Partial<Pick<Skill, 'name' | 'description' | 'skillMd' | 'target' | 'isGlobal' | 'files'>> }) =>
      skillApi.update(documentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skill'] });
      queryClient.invalidateQueries({ queryKey: ['skills-effective'] });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => skillApi.delete(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skills-effective'] });
    },
  });
}

export function useSkillSyncStatus(projectDocumentId?: string) {
  return useQuery({
    queryKey: ['skill-sync-status', projectDocumentId],
    queryFn: () => skillApi.syncStatus(projectDocumentId!),
    enabled: !!projectDocumentId,
    refetchInterval: 30000,
  });
}

// Skill Studio 5 (ISS-279) — aggregated skill-major per-device freshness for
// the Studio sync panel. 30s poll so freshness catches up after a device
// reports its install hashes back.
export function useProjectSkillSyncStatus(projectDocumentId?: string) {
  return useQuery({
    queryKey: ['skill-sync-status-by-device', projectDocumentId],
    queryFn: () => skillApi.projectSyncStatus(projectDocumentId!),
    enabled: !!projectDocumentId,
    refetchInterval: 30000,
  });
}

export function useBulkPushSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targets, projectDocumentId, skillNames, deviceId }: {
      targets: string[];
      projectDocumentId: string;
      skillNames?: string[];
      deviceId?: string;
    }) => skillApi.bulkPush(targets, projectDocumentId, skillNames, deviceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skill-sync-status'] });
      // Skill Studio 5 — also refresh the by-device aggregate + per-device views
      // so a Sync now reflects once the runner pulls and reports back.
      queryClient.invalidateQueries({ queryKey: ['skill-sync-status-by-device'] });
      queryClient.invalidateQueries({ queryKey: ['device-skill-status'] });
    },
  });
}

// Skill Studio 5 (ISS-279) — per-device skill freshness for the device-centric
// settings page (reuses the existing single-device endpoint).
export function useDeviceSkillStatus(
  projectId: string | undefined,
  deviceId: string | undefined,
) {
  return useQuery({
    queryKey: ['device-skill-status', projectId, deviceId],
    queryFn: () => deviceApi.skillStatus(projectId as string, deviceId as string),
    enabled: !!projectId && !!deviceId,
    refetchInterval: 30000,
  });
}

// EPIC 6 (ISS-278/290) — effective skills + per-project override mutations.
export function useEffectiveSkills(projectId?: string) {
  return useQuery({
    queryKey: ['skills-effective', projectId],
    queryFn: () => skillApi.getEffective(projectId!),
    enabled: !!projectId,
  });
}

export function useUpsertSkillOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, skillId, skillMdOverride, files }: {
      projectId: string;
      skillId: string;
      skillMdOverride: string;
      files?: SkillFile[];
    }) => skillApi.upsertOverride(projectId, skillId, skillMdOverride, files),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['skills-effective', vars.projectId] });
    },
  });
}

export function useDeleteSkillOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, skillId }: { projectId: string; skillId: string }) =>
      skillApi.deleteOverride(projectId, skillId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['skills-effective', vars.projectId] });
    },
  });
}

// ISS-109 — per-project skill ↔ stage bindings. Read on settings panel,
// mutated by the row controls (dropdown change / clear button).
const REGISTRATIONS_KEY = (projectId: string | undefined) =>
  ['project', projectId, 'skill-registrations'] as const;

export function useProjectSkillRegistrations(projectId: string | undefined) {
  return useQuery({
    queryKey: REGISTRATIONS_KEY(projectId),
    queryFn: () => skillRegistrationApi.list(projectId as string),
    enabled: !!projectId,
  });
}

export function useRegisterSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, stage }: { skillId: string; stage: string | null }) =>
      skillRegistrationApi.register(projectId, skillId, stage),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REGISTRATIONS_KEY(projectId) });
      queryClient.invalidateQueries({ queryKey: ['skill-sync-status'] });
    },
  });
}

export function useUnregisterSkillByStage(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stage: string) => skillRegistrationApi.unregister(projectId, stage),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REGISTRATIONS_KEY(projectId) });
    },
  });
}
