"use client";

// Create-issue flow (ISS-331). A SlideOver-hosted form wired to
// `POST /api/projects/:id/issues` via `useCreateIssue`. Title is required
// (mirrors the server schema); priority defaults to `medium`; description,
// category, and complexity are optional. On success we invalidate `['issues']`
// (done by the hook) and navigate to the new issue's detail page. Modeled on
// the New Project dialog (ISS-319).
import { type FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Banner, Button, Field, Input, Select, SlideOver, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useCreateIssue } from "../hooks";
import type { IssueComplexity, IssuePriority } from "../types";
import { COMPLEXITY_OPTIONS, PRIORITY_OPTIONS } from "./issue-table-row";

export interface NewIssueDialogProps {
  open: boolean;
  onClose: () => void;
  scope: { projectId: string; slug: string };
}

export function NewIssueDialog({ open, onClose, scope }: NewIssueDialogProps) {
  const router = useRouter();
  const { toast } = useToast();
  const create = useCreateIssue(scope.projectId);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [category, setCategory] = useState("");
  const [complexity, setComplexity] = useState("");
  const [errors, setErrors] = useState<{ title?: string; form?: string }>({});

  // Reset the whole form each time the dialog opens — never leak a prior draft
  // or stale error into a fresh create.
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setPriority("medium");
      setCategory("");
      setComplexity("");
      setErrors({});
      create.reset();
    }
    // `create` is stable from React Query; resetting only on `open` is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 1) {
      setErrors({ title: "Title is required." });
      return;
    }
    if (trimmedTitle.length > 500) {
      setErrors({ title: "Title must be 500 characters or fewer." });
      return;
    }
    setErrors({});

    const trimmedDesc = description.trim();
    const trimmedCategory = category.trim();
    try {
      const created = await create.mutateAsync({
        title: trimmedTitle,
        priority,
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
        ...(trimmedCategory ? { category: trimmedCategory } : {}),
        ...(complexity ? { complexity: complexity as IssueComplexity } : {}),
      });
      toast({ title: "Issue created", description: created.displayId, tone: "success" });
      onClose();
      router.push(`/projects/${scope.slug}/issues/${created.id}`);
    } catch (err) {
      setErrors({ form: formatApiError(err) });
    }
  }

  return (
    <SlideOver open={open} onClose={onClose} title="New issue" width={480}>
      <form onSubmit={onSubmit} className="flex h-full flex-col gap-4">
        {errors.form && <Banner tone="danger">{errors.form}</Banner>}

        <Field label="Title" required error={errors.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary of the issue"
            autoFocus
            maxLength={500}
          />
        </Field>

        <Field label="Description" hint="Optional — context, repro steps, or links.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What needs to happen and why…"
            maxLength={100_000}
            rows={5}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Priority">
            <Select
              aria-label="Priority"
              value={priority}
              options={PRIORITY_OPTIONS}
              onChange={(v) => setPriority(v as IssuePriority)}
            />
          </Field>
          <Field label="Complexity" hint="Optional.">
            <Select
              aria-label="Complexity"
              value={complexity}
              options={COMPLEXITY_OPTIONS}
              onChange={setComplexity}
            />
          </Field>
        </div>

        <Field label="Category" hint="Optional — e.g. bug, feature, chore.">
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="bug"
            maxLength={100}
          />
        </Field>

        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="plus" loading={create.isPending}>
            Create issue
          </Button>
        </div>
      </form>
    </SlideOver>
  );
}
