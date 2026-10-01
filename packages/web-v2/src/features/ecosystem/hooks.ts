"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { questionsApi } from "@/features/questions/api";
import { gateQuestionKey, projectQuestionsKey } from "@/features/questions/hooks";
import { ecosystemApi } from "./api";
import type { RegisterFilter } from "./routes";
import type { ContractReading } from "./types";

const KEY = ["ecosystem"] as const;

export function useProjectEcosystems(projectId: string) {
  return useQuery({
    queryKey: [...KEY, "memberships", projectId],
    queryFn: () => ecosystemApi.ecosystemsOf(projectId),
    enabled: Boolean(projectId),
  });
}

export function useRegister(ecosystemId: string | undefined, projectId: string, filter: RegisterFilter) {
  return useQuery({
    queryKey: [...KEY, "register", ecosystemId, projectId, filter],
    queryFn: () => ecosystemApi.register(ecosystemId as string, { filter, party: projectId }),
    enabled: Boolean(ecosystemId),
  });
}

export function useOutbox(projectId: string) {
  return useQuery({
    queryKey: [...KEY, "outbox", projectId],
    queryFn: () => ecosystemApi.outbox(projectId),
  });
}

export function useDocument(projectId: string, ref: string | undefined) {
  return useQuery({
    queryKey: [...KEY, "document", projectId, ref],
    queryFn: () => ecosystemApi.document(projectId, ref as string),
    enabled: Boolean(ref),
  });
}

export function useThread(projectId: string, number: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, "thread", projectId, number],
    queryFn: () => ecosystemApi.thread(projectId, number as string),
    enabled: Boolean(number),
  });
}

/** The open approve-gate question waiting on one of this project's documents, if any. */
export function useGateQuestion(projectId: string, documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: gateQuestionKey(projectId, documentId),
    queryFn: async () => {
      let cursor: string | undefined;
      do {
        const page = await questionsApi.listOpenWithoutIssue(projectId, cursor, 200);
        const hit = page.questions.find(
          (q) => q.origin?.kind === "channel_gate" && q.origin.documentId === documentId,
        );
        if (hit) return hit;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return null;
    },
    enabled,
  });
}

export function useApiPage(projectId: string) {
  return useQuery({
    queryKey: [...KEY, "api-page", projectId],
    queryFn: () => ecosystemApi.apiPage(projectId),
  });
}

export function useContract(projectId: string, contract: string, provider?: string) {
  return useQuery({
    queryKey: [...KEY, "contract", projectId, contract, provider ?? null],
    queryFn: async (): Promise<ContractReading> => {
      if (provider) {
        const [v, m] = await Promise.all([
          ecosystemApi.consumedVersions(projectId, provider, contract),
          ecosystemApi.consumedMeasurements(projectId, provider, contract),
        ]);
        return { provider: v.provider, versions: v.versions, measurements: m.measurements };
      }
      const [v, m] = await Promise.all([
        ecosystemApi.ownVersions(projectId, contract),
        ecosystemApi.ownMeasurements(projectId, contract),
      ]);
      return { versions: v.versions, measurements: m.measurements };
    },
  });
}

/** One write in the channel. Every success refreshes the module's reads and the questions a write opens or settles. */
export function useChannelWrite<A, R>(write: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["questions"] });
    },
  });
}

/**
 * Answer a gate question. Its key sits under `projectQuestionsKey`, so this refreshes the gate and
 * the Agents queue together. They stay two entries: that one is an infinite query, this a plain one.
 */
export function useAnswerGate(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: questionsApi.answer,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: projectQuestionsKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["attention"] });
    },
  });
}
