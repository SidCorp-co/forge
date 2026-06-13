"use client";

// web-v2 feature module: skills — React Query hooks. Keys are rooted at
// `['skills', projectId]` so the register/unregister mutations can invalidate
// the whole subtree (list + sync-status + registrations) in one shot.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { skillsApi, type SkillCreateInput, type SkillUpdateInput } from "./api";

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

/** Per-stage smoke-verify report (`GET /skills/smoke-verify`). Keyed under
 *  `['skills', projectId]` so register/unregister/push mutations invalidate it
 *  together with the list. While a tier-2 canary is PENDING the report polls
 *  so the verdict lands without a manual refresh. */
export function useSkillSmokeVerify(projectId: string | undefined) {
  return useQuery({
    queryKey: ["skills", projectId, "smoke-verify"],
    queryFn: () => skillsApi.smokeVerify(projectId as string),
    enabled: !!projectId,
    refetchInterval: (query) =>
      query.state.data?.tier2.some((e) => e.status === "PENDING") ? 5_000 : false,
  });
}

/** Run smoke-verify: tier 1 = synchronous static checks; tier 2 = dispatch a
 *  real canary job per registered stage (admin, spends agent budget). */
export function useRunSmokeVerify(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (body: { tier: 1 | 2; stages?: string[] }) =>
      skillsApi.runSmokeVerify(projectId as string, body),
    onSuccess: (data, body) => {
      qc.setQueryData(["skills", projectId, "smoke-verify"], data.report);
      qc.invalidateQueries({ queryKey: ["skills", projectId, "smoke-verify"] });
      const n = data.canary?.dispatched.length ?? 0;
      toast({
        title:
          body.tier === 2
            ? n > 0
              ? `Canary dispatched on ${n} stage${n === 1 ? "" : "s"}`
              : "No canary dispatched (no eligible stage)"
            : "Skill checks refreshed",
        tone: "success",
      });
    },
    onError: (err) => {
      toast({ title: "Smoke-verify failed", description: formatApiError(err), tone: "error" });
    },
  });
}

function useSkillMutation<TArgs, TData = unknown>(
  fn: (args: TArgs) => Promise<TData>,
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

/** Create a new project skill (Skill Studio). Resolves to the new SkillRow. */
export function useCreateSkill(projectId: string | undefined) {
  return useSkillMutation(
    (body: SkillCreateInput) => skillsApi.create(projectId as string, body),
    projectId,
    "Skill created",
  );
}

/** Update an existing project skill's content/metadata (Skill Studio). */
export function useUpdateSkill(projectId: string | undefined) {
  return useSkillMutation(
    ({ skillId, patch }: { skillId: string; patch: SkillUpdateInput }) =>
      skillsApi.update(skillId, patch),
    projectId,
    "Skill saved",
  );
}

/** Clone a global template into a project skill so it becomes usable. The
 *  mutation resolves to the new project SkillRow — callers (e.g. the Pipeline
 *  picker's adopt-on-select) read `.id` to register it to a stage. */
export function useAdoptSkill(projectId: string | undefined) {
  return useSkillMutation(
    (globalSkillId: string) => skillsApi.adopt(projectId as string, globalSkillId),
    projectId,
    "Skill adopted into project",
  );
}
