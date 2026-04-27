'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  useAppConfig,
  useUpsertAppConfig,
} from '@/features/app-config/hooks/use-app-config';
import { useProject, useUpdateProject } from '@/features/project/hooks/use-projects';

export interface SettingsFormState {
  name: string;
  description: string;
  repoPath: string;
  baseBranch: string;
  productionBranch: string;
  systemPromptOverride: string;
  chatProviderId: string;
  chatModel: string;
}

const EMPTY_STATE: SettingsFormState = {
  name: '',
  description: '',
  repoPath: '',
  baseBranch: '',
  productionBranch: '',
  systemPromptOverride: '',
  chatProviderId: '',
  chatModel: '',
};

function nullableString(v: string): string | null {
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function useSettingsForm(projectId: string | undefined) {
  const projectQuery = useProject(projectId);
  const appConfigQuery = useAppConfig(projectId);
  const updateProject = useUpdateProject();
  const upsertAppConfig = useUpsertAppConfig();

  const initial = useMemo<SettingsFormState>(() => {
    const p = projectQuery.data;
    const cfg = appConfigQuery.data;
    return {
      name: p?.name ?? '',
      description: p?.description ?? '',
      repoPath: p?.repoPath ?? '',
      baseBranch: p?.baseBranch ?? '',
      productionBranch: p?.productionBranch ?? '',
      systemPromptOverride: cfg?.systemPromptOverride ?? '',
      chatProviderId: cfg?.chatProviderId ?? '',
      chatModel: cfg?.chatModel ?? '',
    };
  }, [projectQuery.data, appConfigQuery.data]);

  const [state, setState] = useState<SettingsFormState>(EMPTY_STATE);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  const setField = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
  };

  const isDirty = useMemo(() => {
    return (Object.keys(state) as Array<keyof SettingsFormState>).some(
      (k) => state[k] !== initial[k],
    );
  }, [state, initial]);

  const isSubmitting = updateProject.isPending || upsertAppConfig.isPending;
  const isLoading = projectQuery.isLoading || appConfigQuery.isLoading;

  async function save() {
    if (!projectId) return;
    const projectPatch: Record<string, unknown> = {};
    if (state.name !== initial.name) projectPatch.name = state.name.trim();
    if (state.description !== initial.description)
      projectPatch.description = nullableString(state.description);
    if (state.repoPath !== initial.repoPath)
      projectPatch.repoPath = nullableString(state.repoPath);
    if (state.baseBranch !== initial.baseBranch)
      projectPatch.baseBranch = nullableString(state.baseBranch);
    if (state.productionBranch !== initial.productionBranch)
      projectPatch.productionBranch = nullableString(state.productionBranch);

    const appConfigPatch: Record<string, unknown> = {};
    if (state.systemPromptOverride !== initial.systemPromptOverride)
      appConfigPatch.systemPromptOverride = nullableString(state.systemPromptOverride);
    if (state.chatProviderId !== initial.chatProviderId)
      appConfigPatch.chatProviderId = nullableString(state.chatProviderId);
    if (state.chatModel !== initial.chatModel)
      appConfigPatch.chatModel = nullableString(state.chatModel);

    if (Object.keys(projectPatch).length > 0) {
      await updateProject.mutateAsync({ id: projectId, patch: projectPatch });
    }
    if (Object.keys(appConfigPatch).length > 0) {
      await upsertAppConfig.mutateAsync({ projectId, patch: appConfigPatch });
    }
  }

  function reset() {
    setState(initial);
  }

  return {
    state,
    setField,
    project: projectQuery.data ?? null,
    appConfig: appConfigQuery.data ?? null,
    isLoading,
    isDirty,
    isSubmitting,
    isError: updateProject.isError || upsertAppConfig.isError,
    isSuccess: updateProject.isSuccess || upsertAppConfig.isSuccess,
    save,
    reset,
  };
}
