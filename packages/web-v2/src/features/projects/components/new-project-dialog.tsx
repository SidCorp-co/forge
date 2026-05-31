'use client';

// Create-project flow (ISS-319). A SlideOver-hosted form wired to
// `POST /api/projects` via `useCreateProject`. Slug auto-derives from the name
// until the user edits it by hand; client validation mirrors the server schema
// (slug 3–64 lowercase/digits/hyphens, name 1–200). On success we invalidate
// `['projects']` (done by the hook) and navigate to the new project.
import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Field, Input, SlideOver, Textarea } from '@/design';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { useToast } from '@/providers/toast-provider';
import { useCreateProject } from '../hooks';

/** Name → slug: lowercase, non-alphanumerics → hyphens, collapse + trim. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const SLUG_RE = /^[a-z0-9-]+$/;

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewProjectDialog({ open, onClose }: NewProjectDialogProps) {
  const router = useRouter();
  const { toast } = useToast();
  const create = useCreateProject();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<{ name?: string; slug?: string; form?: string }>({});

  // Reset the whole form each time the dialog opens — never leak a prior draft
  // or stale error into a fresh create.
  useEffect(() => {
    if (open) {
      setName('');
      setSlug('');
      setSlugEdited(false);
      setDescription('');
      setErrors({});
      create.reset();
    }
    // `create` is stable from React Query; resetting only on `open` is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Mirror the name into the slug until the user takes manual control.
  const onNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };

  const onSlugChange = (value: string) => {
    setSlugEdited(true);
    setSlug(value);
  };

  function validate(trimmedName: string, trimmedSlug: string) {
    const next: { name?: string; slug?: string } = {};
    if (trimmedName.length < 1) next.name = 'Name is required.';
    else if (trimmedName.length > 200) next.name = 'Name must be 200 characters or fewer.';
    if (trimmedSlug.length < 3) next.slug = 'Slug must be at least 3 characters.';
    else if (trimmedSlug.length > 64) next.slug = 'Slug must be 64 characters or fewer.';
    else if (!SLUG_RE.test(trimmedSlug))
      next.slug = 'Slug may use lowercase letters, digits, and hyphens only.';
    return next;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    const fieldErrors = validate(trimmedName, trimmedSlug);
    if (fieldErrors.name || fieldErrors.slug) {
      setErrors(fieldErrors);
      return;
    }
    setErrors({});

    const trimmedDesc = description.trim();
    try {
      const created = await create.mutateAsync({
        slug: trimmedSlug,
        name: trimmedName,
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
      });
      toast({ title: 'Project created', description: created.name, tone: 'success' });
      onClose();
      router.push(`/projects/${created.slug}`);
    } catch (err) {
      // A taken slug is a field-level problem; everything else is a form banner.
      if (err instanceof ApiError && err.code === 'SLUG_TAKEN') {
        setErrors({ slug: 'That slug is already taken.' });
      } else {
        setErrors({ form: formatApiError(err) });
      }
    }
  }

  return (
    <SlideOver open={open} onClose={onClose} title="New project" width={460}>
      <form onSubmit={onSubmit} className="flex h-full flex-col gap-4">
        {errors.form && <Banner tone="danger">{errors.form}</Banner>}

        <Field label="Name" required error={errors.name}>
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Acme Platform"
            autoFocus
            maxLength={200}
          />
        </Field>

        <Field
          label="Slug"
          required
          error={errors.slug}
          hint="Used in URLs. Lowercase letters, digits, and hyphens."
        >
          <Input
            value={slug}
            onChange={(e) => onSlugChange(e.target.value)}
            placeholder="acme-platform"
            maxLength={64}
          />
        </Field>

        <Field label="Description" hint="Optional — a short line about this project.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this project is for…"
            maxLength={2000}
            rows={3}
          />
        </Field>

        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="plus" loading={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </SlideOver>
  );
}
