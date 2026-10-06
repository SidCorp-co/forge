"use client";

import { DetailHeader, ErrorState, ProjectLoader, StatusBadge, useListOrigin, useUrlTab } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useContractDetail } from "../hooks";
import { CONTRACTS_LIST, contractsHref } from "@/lib/routes/contracts";
import { ContractAction } from "./contract-bits";
import { CONTRACT_TABS, ContractPage } from "./contract-detail";

// cm:why the shell's top bar is the page's sticky header (the shared DetailHeader): the named back control to Contracts, the ref, the title and the state; the one primary act is whatever the contract waits on the viewer for
export function ContractScreen({ projectId, slug, contractRef }: { projectId: string; slug: string; contractRef: string }) {
  const q = useContractDetail(projectId, contractRef);
  const [tab, setTab] = useUrlTab(CONTRACT_TABS);
  const back = useListOrigin(CONTRACTS_LIST, contractsHref(slug));
  const d = q.data;
  return (
    <div className="min-h-full bg-app" data-testid="contract-screen">
      <DetailHeader
        back={{ href: back, label: "Contracts" }}
        itemKey={d?.contract.ref ?? contractRef}
        title={d?.contract.title ?? contractRef}
        badge={d ? <StatusBadge family="contractState" value={d.contract.state} /> : null}
        action={d ? <ContractAction row={d.contract} slug={slug} onVersions={() => setTab("versions")} /> : null}
      />
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading contract…" />
        </div>
      ) : q.isError || !d ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : (
        <ContractPage d={d} slug={slug} projectId={projectId} tab={tab} onTab={setTab} />
      )}
    </div>
  );
}
