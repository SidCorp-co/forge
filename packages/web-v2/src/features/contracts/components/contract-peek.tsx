
import { PeekHead, PeekPanel, type FullPage, type PeekState, useOpenFullPage, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useContractDetail } from "../hooks";
import { AdoptionStrip, ContractAction, ContractBanner } from "./contract-bits";
import { ContractProperties } from "./contract-facts";

export function ContractPeek({
  projectId,
  slug,
  contractRef,
  peek,
  full,
}: {
  projectId: string;
  slug: string;
  contractRef: string;
  peek: PeekState;
  full: FullPage;
}) {
  const t = useCopy();
  const q = useContractDetail(projectId, contractRef);
  const openFull = useOpenFullPage(full);
  return (
    <PeekPanel peek={peek} listLabel={t("contracts.title")} noun={t("contracts.noun")} full={full} testId="contract-peek">
      <QueryBoundary query={q} loadingLabel={t("contracts.loadingOne")}>
        {(d) => (
          <>
            <PeekHead
              noun={t("contracts.noun")}
              itemKey={d.contract.ref}
              badge={<StatusBadge family="contractState" value={d.contract.state} />}
              title={d.contract.title}
              action={<ContractAction row={d.contract} slug={slug} onVersions={openFull} />}
            />
            <ContractBanner row={d.contract} slug={slug} className="px-4.5" />
            <div className="flex items-center gap-3 px-4.5 pb-1 pt-4">
              <span className="text-12-5 font-medium text-muted">{t("contracts.tab.adoption")}</span>
              <AdoptionStrip consumers={d.consumers} latest={d.contract.current?.version ?? null} />
            </div>
            <div className="px-4.5 pb-4 pt-3">
              <ContractProperties d={d} slug={slug} />
            </div>
          </>
        )}
      </QueryBoundary>
    </PeekPanel>
  );
}
