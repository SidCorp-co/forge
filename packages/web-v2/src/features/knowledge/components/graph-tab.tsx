"use client";

// Graph inner tab — knowledge-edge relation table extracted from the old KnowledgeScreen.
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
  SlideOver,
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

const MAX_CONTENT = 50_000;

interface GraphTabProps {
  projectId: string;
  canManage: boolean;
}

export function GraphTab({ projectId, canManage }: GraphTabProps) {
  const edgesQ = useKnowledgeEdges(projectId);
  const ingest = useIngestKnowledge(projectId);
  const deleteEdge = useDeleteEdge(projectId);
  const [addOpen, setAddOpen] = useState(false);

  const edges = edgesQ.data ?? [];

  return (
    <div>
      {canManage && (
        <div className="mb-4 flex justify-end">
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add source
          </Button>
        </div>
      )}

      {edgesQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      )}

      {edgesQ.isError && (
        <ErrorState
          title="Couldn't load knowledge graph"
          message={formatApiError(edgesQ.error)}
          onRetry={() => edgesQ.refetch()}
        />
      )}

      {!edgesQ.isLoading && !edgesQ.isError && edges.length === 0 && (
        <EmptyState
          title="No knowledge edges yet"
          message={
            canManage
              ? "Add a source to start building the project knowledge graph."
              : "Once a source is added, its relations will appear here."
          }
          action={
            canManage ? { label: "Add source", onClick: () => setAddOpen(true) } : undefined
          }
        />
      )}

      {!edgesQ.isLoading && !edgesQ.isError && edges.length > 0 && (
        <>
          <div className="hidden md:block">
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <Table>
                <THead>
                  <TR>
                    <TH>Subject</TH>
                    <TH>Predicate</TH>
                    <TH>Object</TH>
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
          </div>

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

      {canManage && (
        <AddSourceDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          ingest={ingest}
        />
      )}
    </div>
  );
}

function AddSourceDialog({
  open,
  onClose,
  ingest,
}: {
  open: boolean;
  onClose: () => void;
  ingest: ReturnType<typeof useIngestKnowledge>;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [errors, setErrors] = useState<{ title?: string; content?: string }>({});
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle("");
    setContent("");
    setErrors({});
  }

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
    ingest.mutate([{ id: crypto.randomUUID(), title: title.trim(), content }], {
      onSuccess: () => {
        reset();
        onClose();
      },
    });
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
    <SlideOver open={open} onClose={onClose} title="Add a source">
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
            rows={10}
            placeholder="Paste the document content here…"
            onChange={(e) => setContent(e.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
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

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <Button
            variant="primary"
            icon="plus"
            loading={ingest.isPending}
            onClick={submit}
            className="min-h-11"
          >
            Ingest
          </Button>
          <Button variant="ghost" onClick={onClose} className="min-h-11">
            Cancel
          </Button>
        </div>
      </div>
    </SlideOver>
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
      </CardContent>
    </Card>
  );
}
