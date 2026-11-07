// The agreements feature's reads and writes: one key factory, one queryOptions per read, and each
// write showing its answer where it reads and having the list read again.

import type { AgreementRestore, AgreementWrite } from "@forge/contracts/agreements";
import { useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { agreementsApi } from "./api";

export const agreementKeys = {
  all: (projectId: string) => ["agreements", projectId] as const,
  list: (projectId: string) => [...agreementKeys.all(projectId), "list"] as const,
  detail: (projectId: string, slug: string | null) => [...agreementKeys.all(projectId), "detail", slug] as const,
  run: (projectId: string, session: string | null) => [...agreementKeys.all(projectId), "run", session] as const,
};

export const agreementQueries = {
  list: (projectId: string) => readOf(agreementKeys.list(projectId), () => agreementsApi.list(projectId)),
  detail: (projectId: string, slug: string | null) => readOf(agreementKeys.detail(projectId, slug), () => agreementsApi.one(projectId, slug as string)),
  run: (projectId: string, session: string | null) => readOf(agreementKeys.run(projectId, session), () => agreementsApi.runContext(projectId, session as string), 60_000),
};

export const useAgreements = (projectId: string) => useQuery(agreementQueries.list(projectId));
export const useAgreement = (projectId: string, slug: string | null) => useQuery(agreementQueries.detail(projectId, slug));
export const useRunAgreements = (projectId: string, session: string | null) => useQuery(agreementQueries.run(projectId, session));

/** A project admin's change, or a new agreement of the project's own under `slug`: its answer is the agreement as it now reads, and the list reads again. */
export function useWriteAgreement(projectId: string) {
  return useWrite(({ slug, write }: { slug: string; write: AgreementWrite }) => agreementsApi.write(projectId, slug, write), {
    shows: ({ slug }) => agreementKeys.detail(projectId, slug),
    touches: ({ slug }) => [agreementKeys.list(projectId), agreementKeys.detail(projectId, slug)],
  });
}

/** Restores the default, or retires the project's own addition; its answer is the whole list. */
export function useRestoreAgreement(projectId: string, slug: string) {
  return useWrite((restore: AgreementRestore) => agreementsApi.restore(projectId, slug, restore), {
    shows: agreementKeys.list(projectId),
    touches: [agreementKeys.list(projectId), agreementKeys.detail(projectId, slug)],
  });
}
