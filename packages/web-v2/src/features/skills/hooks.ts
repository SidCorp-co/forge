"use client";

// web-v2 feature module: skills — React Query hooks. Keys are rooted at
// `['skills', projectId]` so the register/unregister mutations can invalidate
// the whole subtree (list + sync-status + registrations) in one shot.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { skillsApi } from "./api";

export function useSkills(projectId: string | undefined) {
  return useQuery({
    queryKey: ["skills", projectId, "list"],
    queryFn: () => skillsApi.list(projectId as string),
    enabled: !!projectId,
  });
}

export function useSkillSyncStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: ["skills", projectId, "sync-status"],
    queryFn: () => skillsApi.syncStatus(projectId as string),
    enabled: !!projectId,
  });
}

/** Per-stage skill bindings for a project (`GET /skill-registrations`). Keyed
 *  under `['skills', projectId]` so register/unregister mutations invalidate it
 *  alongside the list + sync-status. The Pipeline settings tab reads this to
 *  show which skill is wired to each stage and to gate the auto-toggles. */
export function useSkillRegistrations(projectId: string | undefined) {
  return useQuery({
    queryKey: ["skills", projectId, "registrations"],
    queryFn: () => skillsApi.registrations(projectId as string),
    enabled: !!projectId,
  });
}

function useSkillMutation<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
  projectId: string | undefined,
  successMessage: string,
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills", projectId] });
      toast({ title: successMessage, tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useRegisterSkill(projectId: string | undefined) {
  return useSkillMutation(
    ({ skillId, stage }: { skillId: string; stage: string }) =>
      skillsApi.register(projectId as string, skillId, stage),
    projectId,
    "Skill enabled for stage",
  );
}

export function useUnregisterSkill(projectId: string | undefined) {
  return useSkillMutation(
    (stage: string) => skillsApi.unregister(projectId as string, stage),
    projectId,
    "Skill disabled for stage",
  );
}
