"use client";

// web-v2 feature module: knowledge — React Query hooks. Keyed
// `['knowledge', projectId]`; mutations invalidate the edge list on success.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { knowledgeApi } from "./api";
import type { IngestDocument } from "./types";

export function useKnowledgeEdges(projectId: string | undefined) {
  return useQuery({
    queryKey: ["knowledge", projectId, "edges"],
    queryFn: () => knowledgeApi.listEdges(projectId as string),
    enabled: !!projectId,
  });
}

export function useDeleteEdge(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => knowledgeApi.deleteEdge(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge", projectId] });
      toast({ title: "Edge deleted", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't delete edge", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useIngestKnowledge(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (documents: IngestDocument[]) =>
      knowledgeApi.ingest(projectId as string, documents),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["knowledge", projectId] });
      toast({
        title: `Ingested ${res.processed} document${res.processed === 1 ? "" : "s"}`,
        description: `${res.totalChunks} chunks${res.skipped.length ? `, ${res.skipped.length} skipped` : ""}`,
        tone: "success",
      });
    },
    onError: (err) => {
      toast({ title: "Ingest failed", description: formatApiError(err), tone: "error" });
    },
  });
}
