'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { agentApi } from '@/features/agent/api';
import { unwrap } from '@/lib/api/client';

export function useAgentPromptBuild(projectSlug: string, resetSession: () => void) {
  const [draftPrompt, setDraftPrompt] = useState<string | null>(null);
  const [isBuildingPrompt, setIsBuildingPrompt] = useState(false);
  const [pendingIssueIds, setPendingIssueIds] = useState<string[] | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const buildPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (buildPromptTimerRef.current) clearTimeout(buildPromptTimerRef.current);
    };
  }, []);

  const requestBuildPrompt = useCallback(async (issueIds: string[]) => {
    resetSession();
    setIsBuildingPrompt(true);
    setDraftPrompt(null);
    setPendingIssueIds(issueIds);
    if (buildPromptTimerRef.current) clearTimeout(buildPromptTimerRef.current);
    try {
      const res = await agentApi.buildPrompt(projectSlug, issueIds);
      const requestId = unwrap(res).requestId;
      pendingRequestIdRef.current = requestId;
      buildPromptTimerRef.current = setTimeout(() => {
        if (pendingRequestIdRef.current === requestId) {
          pendingRequestIdRef.current = null;
          setIsBuildingPrompt(false);
        }
      }, 15000);
    } catch (err) {
      console.error('[build-prompt] API error:', err);
      setIsBuildingPrompt(false);
    }
  }, [projectSlug, resetSession]);

  const clearDraftPrompt = useCallback(() => {
    setDraftPrompt(null);
    setIsBuildingPrompt(false);
    setPendingIssueIds(null);
    pendingRequestIdRef.current = null;
    if (buildPromptTimerRef.current) {
      clearTimeout(buildPromptTimerRef.current);
      buildPromptTimerRef.current = null;
    }
  }, []);

  /** Handle the WS event for prompt-built */
  const handlePromptBuilt = useCallback((requestId: string, prompt: string | null, error: string | null) => {
    if (requestId && requestId === pendingRequestIdRef.current) {
      pendingRequestIdRef.current = null;
      if (buildPromptTimerRef.current) { clearTimeout(buildPromptTimerRef.current); buildPromptTimerRef.current = null; }
      if (error || !prompt) {
        setDraftPrompt(null);
      } else {
        setDraftPrompt(prompt);
      }
      setIsBuildingPrompt(false);
    }
  }, []);

  /** Handle the WS event for preview-prompt */
  const handlePreviewPrompt = useCallback((prompt: string, issueIds: string[] | undefined) => {
    setDraftPrompt(prompt);
    setPendingIssueIds(issueIds?.length ? issueIds : null);
    setIsBuildingPrompt(false);
  }, []);

  return {
    draftPrompt, setDraftPrompt,
    isBuildingPrompt,
    pendingIssueIds, setPendingIssueIds,
    requestBuildPrompt,
    clearDraftPrompt,
    handlePromptBuilt,
    handlePreviewPrompt,
  };
}
