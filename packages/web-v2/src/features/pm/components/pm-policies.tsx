"use client";

// PM Policies tab: list policies (priority-ordered) with an enable Toggle and
// an edit/delete Menu; create/edit via a SlideOver editor.
import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Menu,
  ProjectLoader,
  SlideOver,
  Textarea,
  Toggle,
  type MenuItem,
} from "@/design";
import { useCreatePolicy, useDeletePolicy, usePmPolicies, useUpdatePolicy } from "../hooks";
import type { PmPolicy } from "../types";

export function PmPolicies({ projectId }: { projectId: string }) {
  const q = usePmPolicies(projectId);
  const update = useUpdatePolicy(projectId);
  const del = useDeletePolicy(projectId);
  const [editing, setEditing] = useState<PmPolicy | null | "new">(null);

  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading policies…" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <ErrorState
        title="Couldn't load policies"
        message="We couldn't reach the PM service. Retry in a moment."
        onRetry={() => q.refetch()}
      />
    );
  }

  const policies = [...(q.data ?? [])].sort((a, b) => b.priority - a.priority);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="fg-body-sm">Standing instructions the PM agent applies, highest priority first.</p>
        <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing("new")}>
          New policy
        </Button>
      </div>

      {policies.length === 0 ? (
        <EmptyState
          title="No policies"
          message="Add a policy to steer how the PM agent triages, prioritises, and dispatches work."
          action={{ label: "New policy", onClick: () => setEditing("new") }}
        />
      ) : (
        <div className="space-y-2.5">
          {policies.map((p) => {
            const items: MenuItem[] = [
              { label: "Edit", icon: "settings", onSelect: () => setEditing(p) },
              { label: "Delete", icon: "trash", danger: true, onSelect: () => del.mutate(p.id) },
            ];
            return (
              <Card key={p.id}>
                <CardContent>
                  <div className="flex items-start gap-3">
                    <Toggle
                      checked={p.enabled}
                      aria-label={`${p.enabled ? "Disable" : "Enable"} ${p.name}`}
                      onChange={(checked) => update.mutate({ id: p.id, patch: { enabled: checked } })}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="fg-body-sm font-semibold text-fg">{p.name}</span>
                        <span className="fg-caption font-mono">P{p.priority}</span>
                      </div>
                      <p className="fg-body-sm mt-1 whitespace-pre-wrap text-muted">{p.body}</p>
                    </div>
                    <Menu
                      align="right"
                      items={items}
                      trigger={
                        <IconButton icon="more" aria-label="Policy actions" className="min-h-11 min-w-11" />
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {editing !== null && (
        <PolicyEditor
          projectId={projectId}
          policy={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Create/edit editor. Mounted only while open (keyed by caller) so the form
 *  state resets per policy. Owns its own create/update mutations. */
function PolicyEditor({
  projectId,
  policy,
  onClose,
}: {
  projectId: string;
  policy: PmPolicy | null;
  onClose: () => void;
}) {
  const create = useCreatePolicy(projectId);
  const update = useUpdatePolicy(projectId);
  const [name, setName] = useState(policy?.name ?? "");
  const [body, setBody] = useState(policy?.body ?? "");
  const [priority, setPriority] = useState(String(policy?.priority ?? 0));

  const saving = create.isPending || update.isPending;
  const valid = name.trim().length > 0 && body.trim().length > 0;

  function save() {
    const payload = { name: name.trim(), body: body.trim(), priority: Number(priority) || 0 };
    if (policy) {
      update.mutate({ id: policy.id, patch: payload }, { onSuccess: onClose });
    } else {
      create.mutate(payload, { onSuccess: onClose });
    }
  }

  return (
    <SlideOver open onClose={onClose} title={policy ? "Edit policy" : "New policy"} width={460}>
      <div className="space-y-4 p-5">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Prefer small batches" />
        </Field>
        <Field label="Body" required hint="What the PM agent should do.">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
        </Field>
        <Field label="Priority" hint="Higher runs first (0–1000).">
          <Input
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            min={0}
            max={1000}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!valid} onClick={save}>
            {policy ? "Save" : "Create"}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
