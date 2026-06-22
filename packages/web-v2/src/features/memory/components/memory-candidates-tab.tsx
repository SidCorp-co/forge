"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Divider,
  EmptyState,
  ErrorState,
  MonoTag,
  Pagination,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { CANDIDATES_PAGE_SIZE } from "../api";
import { useMemoryCandidates, useReviewCandidate } from "../hooks";
import {
  type EvidenceRef,
  type MemoryCandidate,
  signalTypeLabel,
  signalTypeTone,
} from "../types";

interface MemoryCandidatesTabProps {
  scope: { projectId: string };
}

export function MemoryCandidatesTab({ scope }: MemoryCandidatesTabProps) {
  const { projectId } = scope;
  const [page, setPage] = useState(1);
  const { toast } = useToast();
  const candidatesQ = useMemoryCandidates({ projectId, page });
  const { accept, reject } = useReviewCandidate(projectId);

  const items = candidatesQ.data?.items ?? [];
  const totalCount = candidatesQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / CANDIDATES_PAGE_SIZE));
  const busy = accept.isPending || reject.isPending;

  const handleAccept = async (id: string) => {
    try {
      await accept.mutateAsync(id);
      toast({ title: "Memory saved", tone: "success" });
    } catch (err) {
      toast({ title: "Failed to accept candidate", tone: "error", description: formatApiError(err) });
    }
  };

  const handleReject = async (id: string) => {
    try {
      await reject.mutateAsync(id);
      toast({ title: "Candidate rejected" });
    } catch (err) {
      toast({ title: "Failed to reject candidate", tone: "error", description: formatApiError(err) });
    }
  };

  return (
    <div className="space-y-4">
      {candidatesQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      )}

      {candidatesQ.isError && (
        <ErrorState
          title="Couldn't load candidates"
          message={formatApiError(candidatesQ.error)}
          onRetry={() => candidatesQ.refetch()}
        />
      )}

      {!candidatesQ.isLoading && !candidatesQ.isError && items.length === 0 && (
        <EmptyState
          title="No candidates waiting for review"
          message="The observer will propose memory candidates as pipeline runs complete."
          mascot
        />
      )}

      {!candidatesQ.isLoading && items.length > 0 && (
        <div className="space-y-2.5">
          {items.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              onAccept={handleAccept}
              onReject={handleReject}
              busy={busy}
            />
          ))}
        </div>
      )}

      {!candidatesQ.isLoading && totalCount > CANDIDATES_PAGE_SIZE && (
        <div className="mt-6 flex justify-center">
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  );
}

interface CandidateCardProps {
  candidate: MemoryCandidate;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  busy: boolean;
}

function CandidateCard({ candidate, onAccept, onReject, busy }: CandidateCardProps) {
  const [confirming, setConfirming] = useState<"accept" | "reject" | null>(null);
  const confidence = (Number(candidate.confidence) * 100).toFixed(0);

  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={signalTypeTone(candidate.signalType)}>
            {signalTypeLabel(candidate.signalType)}
          </Badge>
          <MonoTag>{candidate.signalKey}</MonoTag>
          <span className="fg-mono ml-auto text-subtle tabular-nums" title="Confidence">
            {confidence}% · {candidate.evidenceCount} run{candidate.evidenceCount === 1 ? "" : "s"}
          </span>
        </div>

        <Divider className="my-3" />
        <p className="fg-body-sm text-fg">{candidate.summary}</p>

        {candidate.evidence.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {(candidate.evidence as EvidenceRef[]).slice(0, 5).map((e) => (
              <MonoTag key={e.runId}>{e.issueId.slice(0, 8)}</MonoTag>
            ))}
            {candidate.evidence.length > 5 && (
              <span className="fg-caption text-subtle">
                +{candidate.evidence.length - 5} more
              </span>
            )}
          </div>
        )}

        <Divider className="my-3" />

        {confirming === null ? (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => setConfirming("accept")}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming("reject")}>
              Reject
            </Button>
          </div>
        ) : confirming === "accept" ? (
          <div className="flex items-center gap-2">
            <span className="fg-body-sm text-subtle">Write to memory?</span>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={() => {
                setConfirming(null);
                onAccept(candidate.id);
              }}
            >
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="fg-body-sm text-subtle">Archive this candidate?</span>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={() => {
                setConfirming(null);
                onReject(candidate.id);
              }}
            >
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
