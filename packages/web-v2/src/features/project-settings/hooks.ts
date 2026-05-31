"use client";

// web-v2 feature module: project-settings — React Query hooks. Mutations
// invalidate the shared project keys (`['project', id]` + `['projects']`) the
// `projects` feature already uses, so the dashboard/console reflect edits and
// the WS reconnect-replay (keyed `['projects']`) keeps live updates working.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { ApiError } from "@/lib/api/client";
import { projectSettingsApi } from "./api";
import type { PipelineConfig, ProjectUpdateInput } from "./types";

/** PATCH project basics/repo. Invalidates the detail + console list. */
export function useUpdateProject(id: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (patch: ProjectUpdateInput) =>
      projectSettingsApi.update(id as string, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: "Project saved", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't save project", description: formatApiError(err), tone: "error" }),
  });
}

/** GET pipeline config. `enabled:false` on the query when the flag is off is
 *  NOT possible to know ahead of time — instead the caller branches on the
 *  `FEATURE_OFF` error code (404) to render an info empty-state. */
export function usePipelineConfig(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id, "pipeline-config"],
    queryFn: () => projectSettingsApi.getPipelineConfig(id as string),
    enabled: !!id,
    // FEATURE_OFF / FORBIDDEN won't resolve by retrying — surface immediately.
    retry: false,
  });
}

export function useUpdatePipelineConfig(id: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (cfg: PipelineConfig) =>
      projectSettingsApi.updatePipelineConfig(id as string, cfg),
    onSuccess: (data) => {
      qc.setQueryData(["project", id, "pipeline-config"], data);
      toast({ title: "Pipeline config saved", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't save pipeline config", description: formatApiError(err), tone: "error" }),
  });
}

export function useMembers(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id, "members"],
    queryFn: () => projectSettingsApi.listMembers(id as string),
    enabled: !!id,
  });
}

export function useInviteMember(id: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: "admin" | "member" }) =>
      projectSettingsApi.inviteMember(id as string, email, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id, "members"] });
      toast({ title: "Invitation sent", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't invite member", description: formatApiError(err), tone: "error" }),
  });
}

export function useRemoveMember(id: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (userId: string) => projectSettingsApi.removeMember(id as string, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id, "members"] });
      qc.invalidateQueries({ queryKey: ["project", id] });
      toast({ title: "Member removed", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't remove member", description: formatApiError(err), tone: "error" }),
  });
}

export function useLabels(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id, "labels"],
    queryFn: () => projectSettingsApi.listLabels(id as string),
    enabled: !!id,
  });
}

export function useCreateLabel(id: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color: string }) =>
      projectSettingsApi.createLabel(id as string, name, color),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id, "labels"] });
      qc.invalidateQueries({ queryKey: ["project", id] });
      toast({ title: "Label created", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't create label", description: formatApiError(err), tone: "error" }),
  });
}

export function useDeleteLabel(id: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (labelId: string) => projectSettingsApi.deleteLabel(labelId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", id, "labels"] });
      qc.invalidateQueries({ queryKey: ["project", id] });
      toast({ title: "Label deleted", tone: "success" });
    },
    onError: (err) =>
      toast({ title: "Couldn't delete label", description: formatApiError(err), tone: "error" }),
  });
}

/** True when an error is the pipeline `FEATURE_OFF` 404 (flag disabled). */
export function isFeatureOff(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.code === "FEATURE_OFF");
}
