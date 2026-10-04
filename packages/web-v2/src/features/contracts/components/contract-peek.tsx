"use client";

import { ErrorState, PeekHead, PeekPanel, type PeekState, ProjectLoader } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useContractDetail } from "../hooks";
import { AdoptionStrip, ContractAction, ContractBanner, ContractStateBadge } from "./contract-bits";
import { ContractFacts } from "./contract-facts";

export function ContractPeek({
  projectId,
  slug,
  contractRef,
  peek,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  contractRef: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const q = useContractDetail(projectId, contractRef);
  const d = q.data;
  return (
    <PeekPanel peek={peek} listLabel="Contracts" noun="Contract" onOpenFull={onOpenFull} testId="contract-peek">
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading contract…" />
        </div>
      ) : q.isError || !d ? (
        <div className="grid min-h-[40vh] place-items-center p-4">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : (
        <>
          <PeekHead
            noun="Contract"
            itemKey={d.contract.ref}
            badge={<ContractStateBadge row={d.contract} />}
            title={d.contract.title}
            action={<ContractAction row={d.contract} slug={slug} onVersions={onOpenFull} />}
          />
          <ContractBanner row={d.contract} slug={slug} className="px-[18px]" />
          <div className="flex items-center gap-3 px-[18px] pb-1 pt-4">
            <span className="text-12-5 font-medium text-muted">Adoption</span>
            <AdoptionStrip consumers={d.consumers} latest={d.contract.current?.version ?? null} />
          </div>
          <div className="px-[18px] pb-4 pt-3">
            <ContractFacts d={d} slug={slug} />
          </div>
        </>
      )}
    </PeekPanel>
  );
}
