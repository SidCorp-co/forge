import type { AgreementDetailView, AgreementRestore, AgreementsView, AgreementWrite } from "@forge/contracts/agreements";
import type { RunContextView } from "@forge/contracts/run-context";
import type { RunStandingList } from "@forge/contracts/run-standing";
import { apiClient } from "@/lib/api/client";

const agreementsPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/agreements`;
const onePath = (projectId: string, slug: string) => `${agreementsPath(projectId)}/${encodeURIComponent(slug)}`;

/** A project's working agreements (REQ-90), the doors `@forge/contracts/agreements` names. */
export const agreementsApi = {
  list: (projectId: string) => apiClient<AgreementsView>(agreementsPath(projectId)),
  one: (projectId: string, slug: string) => apiClient<AgreementDetailView>(onePath(projectId, slug)),
  write: (projectId: string, slug: string, write: AgreementWrite) =>
    apiClient<AgreementDetailView>(onePath(projectId, slug), { method: "PUT", body: JSON.stringify(write) }),
  restore: (projectId: string, slug: string, restore: AgreementRestore) =>
    apiClient<AgreementsView>(`${onePath(projectId, slug)}/restore`, { method: "POST", body: JSON.stringify(restore) }),
  /** The project's newest runs, the ones the context switch offers (`runs/standing`, every scope). */
  runs: (projectId: string, limit: number) => apiClient<RunStandingList>(`/projects/${encodeURIComponent(projectId)}/runs/standing?scope=all&limit=${limit}`),
  /** What one run session was given (run-context); its agreements are the rows of kind `agreement`. */
  runContext: (projectId: string, session: string) =>
    apiClient<RunContextView>(`/projects/${encodeURIComponent(projectId)}/run-context?session=${encodeURIComponent(session)}`),
};
