"use client";

// Project-tier Knowledge (`/v2/projects/[slug]/knowledge`). User-provided
// sources: an ingest panel (paste or read a file client-side → /knowledge/ingest)
// and the resulting knowledge-edge graph rendered as a relation table. ISS-299.
import { useRef, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  MonoTag,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useDeleteEdge, useIngestKnowledge, useKnowledgeEdges } from "../hooks";
import type { KnowledgeEdge } from "../types";

interface KnowledgeScreenProps {
  scope: { projectId: string; canManage: boolean };
}

const MAX_CONTENT = 50_000;

export function KnowledgeScreen({ scope }: KnowledgeScreenProps) {
  const { projectId, canManage } = scope;
  const edgesQ = useKnowledgeEdges(projectId);
  const ingest = useIngestKnowledge(projectId);
  const deleteEdge = useDeleteEdge(projectId);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [errors, setErrors] = useState<{ title?: string; content?: string }>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const edges = edgesQ.data ?? [];

  function validate(): boolean {
    const next: typeof errors = {};
    if (!title.trim()) next.title = "Title is required.";
    if (!content.trim()) next.content = "Paste content or upload a file.";
    else if (content.length > MAX_CONTENT) next.content = `Content exceeds ${MAX_CONTENT} characters.`;
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submit() {
    if (!validate()) return;
    ingest.mutate(
      [{ id: crypto.randomUUID(), title: title.trim(), content }],
      {
        onSuccess: () => {
          setTitle("");
          setContent("");
          setErrors({});
        },
      },
    );
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setContent(text.slice(0, MAX_CONTENT));
    if (!title.trim()) setTitle(file.name);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6">
        <h1 className="fg-h2">Knowledge</h1>
        <p className="fg-body-sm mt-1">
          Sources you provide are chunked, embedded, and linked into the project knowledge graph.
        </p>
      </header>

      {canManage && (
        <Card className="mb-8">
          <CardContent>
            <h2 className="fg-h3 mb-4">Ingest a source</h2>
            <div className="space-y-4">
              <Field label="Title" required error={errors.title}>
                <Input
                  value={title}
                  placeholder="e.g. API style guide"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field
                label="Content"
                required
                error={errors.content}
                hint={`Paste text or upload a file. Up to ${MAX_CONTENT.toLocaleString()} characters.`}
              >
                <Textarea
                  value={content}
                  rows={6}
                  placeholder="Paste the document content here…"
                  onChange={(e) => setContent(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  icon="plus"
                  loading={ingest.isPending}
                  onClick={submit}
                  className="min-h-11"
                >
                  Ingest
                </Button>
                <Button
                  variant="secondary"
                  icon="inbox"
                  onClick={() => fileRef.current?.click()}
                  className="min-h-11"
                >
                  Upload file
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.json,.csv,text/*"
                  className="hidden"
                  onChange={onFile}
                />
                {content && (
                  <span className="fg-caption">
                    {content.length.toLocaleString()} / {MAX_CONTENT.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <h2 className="fg-h3 mb-3">Knowledge graph</h2>

      {edgesQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      )}

      {edgesQ.isError && (
        <ErrorState
          title="Couldn't load knowledge"
          message={formatApiError(edgesQ.error)}
          onRetry={() => edgesQ.refetch()}
        />
      )}

      {!edgesQ.isLoading && !edgesQ.isError && edges.length === 0 && (
        <EmptyState
          title="No knowledge edges yet"
          message="Ingest a source above to start building the project knowledge graph."
        />
      )}

      {!edgesQ.isLoading && !edgesQ.isError && edges.length > 0 && (
        <>
          {/* Desktop: relation table (subject → predicate → object). */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH>Subject</TH>
                  <TH>Predicate</TH>
                  <TH>Object</TH>
                  <TH>Value</TH>
                  <TH className="text-right">Confidence</TH>
                  {canManage && <TH className="w-12" aria-label="Actions" />}
                </TR>
              </THead>
              <TBody>
                {edges.map((edge) => (
                  <TR key={edge.id}>
                    <TD className="font-medium text-fg">{edge.subject}</TD>
                    <TD>
                      <MonoTag hue="cobalt">{edge.predicate}</MonoTag>
                    </TD>
                    <TD className="text-fg">{edge.object}</TD>
                    <TD className="text-muted">{edge.value ?? "—"}</TD>
                    <TD className="text-right font-mono text-muted">
                      {edge.confidence == null ? "—" : edge.confidence.toFixed(2)}
                    </TD>
                    {canManage && (
                      <TD className="text-right">
                        <IconButton
                          icon="trash"
                          aria-label={`Delete edge ${edge.subject} ${edge.predicate} ${edge.object}`}
                          disabled={deleteEdge.isPending}
                          onClick={() => deleteEdge.mutate(edge.id)}
                          className="min-h-11 min-w-11"
                        />
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards. */}
          <div className="space-y-2.5 md:hidden">
            {edges.map((edge) => (
              <EdgeMobileCard
                key={edge.id}
                edge={edge}
                canManage={canManage}
                onDelete={() => deleteEdge.mutate(edge.id)}
                pending={deleteEdge.isPending}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EdgeMobileCard({
  edge,
  canManage,
  onDelete,
  pending,
}: {
  edge: KnowledgeEdge;
  canManage: boolean;
  onDelete: () => void;
  pending: boolean;
}) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="fg-body-sm font-medium text-fg">{edge.subject}</span>
              <MonoTag hue="cobalt">{edge.predicate}</MonoTag>
              <span className="fg-body-sm text-fg">{edge.object}</span>
            </div>
            {edge.value && <p className="fg-caption mt-1.5">{edge.value}</p>}
          </div>
          {canManage && (
            <IconButton
              icon="trash"
              aria-label="Delete edge"
              disabled={pending}
              onClick={onDelete}
              className="min-h-11 min-w-11"
            />
          )}
        </div>
        {edge.confidence != null && (
          <p className="fg-caption mt-2 font-mono">confidence {edge.confidence.toFixed(2)}</p>
        )}
      </CardContent>
    </Card>
  );
}
