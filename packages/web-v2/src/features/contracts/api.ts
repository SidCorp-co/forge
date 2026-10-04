import { apiClient } from "@/lib/api/client";
import type { ContractStandingDetail, ContractStandingList } from "./types";

const base = (projectId: string) => `/projects/${projectId}/contract-standing`;

export const contractsApi = {
  list: (projectId: string) => apiClient<ContractStandingList>(base(projectId)),
  detail: (projectId: string, ref: string) => {
    const cut = ref.indexOf("/");
    return apiClient<ContractStandingDetail>(
      `${base(projectId)}/${encodeURIComponent(ref.slice(0, cut))}/${encodeURIComponent(ref.slice(cut + 1))}`,
    );
  },
};

export const decideVersion = (
  projectId: string,
  contract: string,
  version: string,
  body: { decision: "approve" | "return"; reason?: string },
) =>
  apiClient<unknown>(
    `/projects/${projectId}/contracts/${encodeURIComponent(contract)}/versions/${encodeURIComponent(version)}/decision`,
    { method: "POST", body: JSON.stringify(body) },
  );
