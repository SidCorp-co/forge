'use client';

import type { PreviewDeployConfig } from '@forge/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useProject, useUpdateProject } from '@/features/project/hooks/use-projects';

export interface TestingUrl {
  label: string;
  url: string;
}

export interface TestCredential {
  label: string;
  username: string;
  password: string;
}

export interface TestingFormState {
  testingUrls: TestingUrl[];
  testCredentials: TestCredential[];
}

const EMPTY: TestingFormState = { testingUrls: [], testCredentials: [] };

function readPreviewDeploy(raw: unknown): PreviewDeployConfig {
  if (!raw || typeof raw !== 'object') return {};
  return raw as PreviewDeployConfig;
}

function readUrls(pd: PreviewDeployConfig): TestingUrl[] {
  const list = pd.testingUrls;
  if (!Array.isArray(list)) return [];
  return list.map((r) => ({ label: r.label ?? '', url: r.url ?? '' }));
}

function readCreds(pd: PreviewDeployConfig): TestCredential[] {
  const list = pd.testCredentials;
  if (!Array.isArray(list)) return [];
  return list.map((r) => ({
    label: r.label ?? '',
    username: r.username ?? '',
    password: r.password ?? '',
  }));
}

function sameUrls(a: TestingUrl[], b: TestingUrl[]) {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.label === b[i]?.label && row.url === b[i]?.url);
}

function sameCreds(a: TestCredential[], b: TestCredential[]) {
  if (a.length !== b.length) return false;
  return a.every(
    (row, i) =>
      row.label === b[i]?.label &&
      row.username === b[i]?.username &&
      row.password === b[i]?.password,
  );
}

export function useTestingForm(projectId: string | undefined) {
  const projectQuery = useProject(projectId);
  const updateProject = useUpdateProject();

  const previewDeploy = useMemo(
    () => readPreviewDeploy(projectQuery.data?.previewDeploy),
    [projectQuery.data?.previewDeploy],
  );

  const initial = useMemo<TestingFormState>(
    () => ({
      testingUrls: readUrls(previewDeploy),
      testCredentials: readCreds(previewDeploy),
    }),
    [previewDeploy],
  );

  const [state, setState] = useState<TestingFormState>(EMPTY);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  const touch = () => {
    if (updateProject.isSuccess || updateProject.isError) updateProject.reset();
  };

  const addUrl = () => {
    setState((s) => ({ ...s, testingUrls: [...s.testingUrls, { label: '', url: '' }] }));
    touch();
  };
  const updateUrl = (i: number, field: keyof TestingUrl, value: string) => {
    setState((s) => ({
      ...s,
      testingUrls: s.testingUrls.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)),
    }));
    touch();
  };
  const removeUrl = (i: number) => {
    setState((s) => ({ ...s, testingUrls: s.testingUrls.filter((_, idx) => idx !== i) }));
    touch();
  };

  const addCredential = () => {
    setState((s) => ({
      ...s,
      testCredentials: [...s.testCredentials, { label: '', username: '', password: '' }],
    }));
    touch();
  };
  const updateCredential = (i: number, field: keyof TestCredential, value: string) => {
    setState((s) => ({
      ...s,
      testCredentials: s.testCredentials.map((r, idx) =>
        idx === i ? { ...r, [field]: value } : r,
      ),
    }));
    touch();
  };
  const removeCredential = (i: number) => {
    setState((s) => ({ ...s, testCredentials: s.testCredentials.filter((_, idx) => idx !== i) }));
    touch();
  };

  const isDirty =
    !sameUrls(state.testingUrls, initial.testingUrls) ||
    !sameCreds(state.testCredentials, initial.testCredentials);

  async function save() {
    if (!projectId) return;
    // Trim empty rows; preserve unknown keys (stagingUrl, etc.) so saving
    // Testing doesn't wipe sibling preview-deploy config written elsewhere.
    const cleanUrls = state.testingUrls
      .map((r) => ({ label: r.label.trim(), url: r.url.trim() }))
      .filter((r) => r.label || r.url);
    const cleanCreds = state.testCredentials
      .map((r) => ({
        label: r.label.trim(),
        username: r.username.trim(),
        password: r.password,
      }))
      .filter((r) => r.label || r.username || r.password);

    const next: PreviewDeployConfig = {
      ...previewDeploy,
      testingUrls: cleanUrls,
      testCredentials: cleanCreds,
    };

    await updateProject.mutateAsync({
      id: projectId,
      patch: { previewDeploy: next },
    });
  }

  function reset() {
    setState(initial);
    if (updateProject.isSuccess || updateProject.isError) updateProject.reset();
  }

  return {
    state,
    addUrl,
    updateUrl,
    removeUrl,
    addCredential,
    updateCredential,
    removeCredential,
    isDirty,
    isSubmitting: updateProject.isPending,
    isError: updateProject.isError,
    isSuccess: updateProject.isSuccess && !isDirty,
    save,
    reset,
  };
}
