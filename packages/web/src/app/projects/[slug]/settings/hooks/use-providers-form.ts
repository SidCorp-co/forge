'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppConfig, useUpsertAppConfig } from '@/features/app-config/hooks/use-app-config';

export interface ProvidersFormState {
  chatProviderId: string;
  chatModel: string;
}

const EMPTY: ProvidersFormState = { chatProviderId: '', chatModel: '' };

function nullableString(v: string): string | null {
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function useProvidersForm(projectId: string | undefined) {
  const cfgQuery = useAppConfig(projectId);
  const upsert = useUpsertAppConfig();

  const initial = useMemo<ProvidersFormState>(
    () => ({
      chatProviderId: cfgQuery.data?.chatProviderId ?? '',
      chatModel: cfgQuery.data?.chatModel ?? '',
    }),
    [cfgQuery.data],
  );

  const [state, setState] = useState<ProvidersFormState>(EMPTY);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  const setField = <K extends keyof ProvidersFormState>(key: K, value: ProvidersFormState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
    if (upsert.isSuccess || upsert.isError) upsert.reset();
  };

  const isDirty =
    state.chatProviderId !== initial.chatProviderId || state.chatModel !== initial.chatModel;

  async function save() {
    if (!projectId || !isDirty) return;
    const patch: Record<string, unknown> = {};
    if (state.chatProviderId !== initial.chatProviderId)
      patch.chatProviderId = nullableString(state.chatProviderId);
    if (state.chatModel !== initial.chatModel) patch.chatModel = nullableString(state.chatModel);
    await upsert.mutateAsync({ projectId, patch });
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
