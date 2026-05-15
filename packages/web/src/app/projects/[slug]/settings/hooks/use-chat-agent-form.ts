'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppConfig, useUpsertAppConfig } from '@/features/app-config/hooks/use-app-config';

export interface ChatAgentFormState {
  systemPromptOverride: string;
}

const EMPTY: ChatAgentFormState = { systemPromptOverride: '' };

function nullableString(v: string): string | null {
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function useChatAgentForm(projectId: string | undefined) {
  const cfgQuery = useAppConfig(projectId);
  const upsert = useUpsertAppConfig();

  const initial = useMemo<ChatAgentFormState>(
    () => ({ systemPromptOverride: cfgQuery.data?.systemPromptOverride ?? '' }),
    [cfgQuery.data],
  );

  const [state, setState] = useState<ChatAgentFormState>(EMPTY);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  const setField = <K extends keyof ChatAgentFormState>(key: K, value: ChatAgentFormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    if (upsert.isSuccess || upsert.isError) upsert.reset();
  };

  const isDirty = state.systemPromptOverride !== initial.systemPromptOverride;

  async function save() {
    if (!projectId || !isDirty) return;
    await upsert.mutateAsync({
      projectId,
      patch: { systemPromptOverride: nullableString(state.systemPromptOverride) },
    });
  }

  function reset() {
    setState(initial);
    if (upsert.isSuccess || upsert.isError) upsert.reset();
  }

  return {
    state,
    setField,
    isDirty,
    isSubmitting: upsert.isPending,
    isError: upsert.isError,
    isSuccess: upsert.isSuccess && !isDirty,
    save,
    reset,
  };
}
