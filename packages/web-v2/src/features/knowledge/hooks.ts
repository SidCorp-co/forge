"use client";

// web-v2 feature module: knowledge — React Query hooks. Keyed
// `['knowledge', projectId, ...]`; mutations invalidate the relevant query on success.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { knowledgeApi } from "./api";
import type { IngestDocument, UpsertKnowledgeBody } from "./types";

// --- Knowledge Entries (P1 REST) ---

export function useKnowledgeEntries(projectId: string | undefined, kind?: string) {
  return useQuery({
    queryKey: ["knowledge", projectId, "entries", kind ?? "all"],
    queryFn: () => knowledgeApi.listEntries(projectId as string, kind ? { kind } : undefined),
    enabled: !!projectId,
  });
}

export function useKnowledgeEntry(projectId: string | undefined, slug: string | undefined) {
  return useQuery({
    queryKey: ["knowledge", projectId, "entry", slug],
    queryFn: () => knowledgeApi.getEntry(projectId as string, slug as string),
    enabled: !!projectId && !!slug,
  });
}

export function useUpsertEntry(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ slug, body }: { slug: string; body: UpsertKnowledgeBody }) =>
      knowledgeApi.upsertEntry(projectId as string, slug, body),
    onSuccess: (_, { slug }) => {
      qc.invalidateQueries({ queryKey: ["knowledge", projectId, "entries"] });
      qc.invalidateQueries({ queryKey: ["knowledge", projectId, "entry", slug] });
      toast({ title: "Entry saved", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't save entry", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useDeleteEntry(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (slug: string) => knowledgeApi.deleteEntry(projectId as string, slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge", projectId, "entries"] });
      toast({ title: "Entry deleted", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't delete entry", description: formatApiError(err), tone: "error" });
    },
  });
}

// --- Knowledge Edges ---

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
