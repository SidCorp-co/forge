'use client';

// Create-project flow (ISS-319, extended in ISS-453 to a 2-step onboarding
// wizard). A SlideOver-hosted form wired to `POST /api/projects` via
// `useCreateProject`. Slug auto-derives from the name until the user edits it
// by hand; client validation mirrors the server schema (slug 3–64
// lowercase/digits/hyphens, name 1–200). On success we invalidate `['projects']`
// (done by the hook) and move to step 2 — "Set up pipeline" — which saves
// repoPath/baseBranch/productionBranch through the EXISTING project PATCH
// (`useUpdateProject`), seeds the stage-mapped skills + Balanced preset via the
// idempotent bootstrap endpoint, and surfaces the runner-bind checklist.
// `pipelineConfig.states` is owned server-side by bootstrap — the client never
// sends a partial pipelineConfig. "Skip for now" routes straight to the project.
import { type FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Banner, Button, Field, Input, Select, SlideOver, Textarea } from '@/design';
import { useOrgs } from '@/features/orgs/hooks';
import { useUpdateProject } from '@/features/project-settings/hooks';
import type { ProjectUpdateInput } from '@/features/project-settings/types';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { useToast } from '@/providers/toast-provider';
import { SLUG_RE, slugify } from '@/lib/slug';
import { useBootstrapProject, useCreateProject } from '../hooks';
import type { BootstrapResult, CreatedProject } from '../types';

export { slugify };

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
  // Target org — '' = the caller's personal org (server default).
  const [orgId, setOrgId] = useState('');
  const orgsQ = useOrgs();
  const teamOrgs = (orgsQ.data ?? []).filter((o) => !o.isPersonal);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; form?: string }>({});

  // Step 2 — "Set up pipeline" (ISS-453). `created` non-null flips the wizard.
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [productionBranch, setProductionBranch] = useState('main');
  const [seedResult, setSeedResult] = useState<BootstrapResult | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const update = useUpdateProject(created?.id);
  const bootstrap = useBootstrapProject(created?.id);

  // Reset the whole form each time the dialog opens — never leak a prior draft
  // or stale error into a fresh create.
  useEffect(() => {
    if (open) {
      setName('');
      setSlug('');
      setSlugEdited(false);
      setDescription('');
      setOrgId('');
      setErrors({});
      setCreated(null);
      setRepoPath('');
      setBaseBranch('main');
      setProductionBranch('main');
      setSeedResult(null);
      setSeedError(null);
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
      const row = await create.mutateAsync({
        slug: trimmedSlug,
        name: trimmedName,
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
        ...(orgId ? { orgId } : {}),
      });
      toast({ title: 'Project created', description: row.name, tone: 'success' });
      // ISS-453 — don't navigate yet: advance to the "Set up pipeline" step.
      setCreated(row);
    } catch (err) {
      // A taken slug is a field-level problem; everything else is a form banner.
      if (err instanceof ApiError && err.code === 'SLUG_TAKEN') {
        setErrors({ slug: 'That slug is already taken.' });
      } else {
        setErrors({ form: formatApiError(err) });
      }
    }
  }

  /** Leave the wizard and land on the new project (step-2 exit, incl. ✕). */
  function finish() {
    if (!created) return;
    onClose();
    router.push(`/projects/${created.slug}`);
  }

  /**
   * Save the repo fields through the existing project PATCH, then seed skills +
   * the Balanced preset via the idempotent bootstrap endpoint. The bootstrap
   * route owns `pipelineConfig.states` — no pipelineConfig is sent from here.
   */
  async function onSeed() {
    if (!created) return;
    setSeedError(null);
    try {
      // Empty string → omit (keep the column's default/null); a set value trims.
      const norm = (v: string) => v.trim();
      const patch: ProjectUpdateInput = {};
      if (norm(repoPath)) patch.repoPath = norm(repoPath);
      if (norm(baseBranch)) patch.baseBranch = norm(baseBranch);
      if (norm(productionBranch)) patch.productionBranch = norm(productionBranch);
      if (Object.keys(patch).length > 0) await update.mutateAsync(patch);

      setSeedResult(await bootstrap.mutateAsync());
    } catch (err) {
      setSeedError(formatApiError(err));
    }
  }

  const seeding = update.isPending || bootstrap.isPending;

  return (
    <SlideOver
      open={open}
      onClose={created ? finish : onClose}
      title={created ? 'Set up pipeline' : 'New project'}
      width={460}
    >
      {created ? (
        <div className="flex h-full flex-col gap-4">
          {seedError && <Banner tone="danger">{seedError}</Banner>}
          {seedResult && (
            <Banner tone="success">
              {seedResult.alreadyBootstrapped
                ? 'Pipeline skills were already seeded for this project.'
                : `Seeded ${seedResult.skillsBound} pipeline skills — pipeline ${
                    seedResult.pipelineEnabled ? 'enabled' : 'disabled'
                  }.`}
            </Banner>
          )}

          <Field
            label="Repository path"
            hint="Absolute path on the runner host where the repo is checked out."
          >
            <Input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/home/runner/projects/my-repo"
              maxLength={500}
              autoFocus
            />
          </Field>
          <Field label="Base branch" hint="Where ISS-* branches are cut from (e.g. main).">
            <Input
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="main"
              maxLength={100}
            />
          </Field>
          <Field
            label="Production branch"
            hint="Where releases squash-merge (often the same as base)."
          >
            <Input
              value={productionBranch}
              onChange={(e) => setProductionBranch(e.target.value)}
              placeholder="main"
              maxLength={100}
            />
          </Field>

          <div>
            <Button
              variant="primary"
              loading={seeding}
              disabled={!!seedResult}
              onClick={onSeed}
              className="min-h-11"
            >
              Seed pipeline skills (Balanced)
            </Button>
            <p className="fg-body-sm mt-1.5 text-subtle">
              Saves the repository settings, binds the stage-mapped forge skills, and applies the
              Balanced pipeline preset. Safe to re-run; everything stays editable in Settings.
            </p>
          </div>

          <div className="border-t border-line-subtle pt-4">
            <span className="fg-label">Connect a runner</span>
            <ol className="fg-body-sm mt-2 list-decimal space-y-1.5 pl-5 text-subtle">
              <li>
                Pair a device with your account: run{' '}
                <code className="font-mono text-[13px] text-fg">forge-runner login</code> on the
                machine that will execute jobs.
              </li>
              <li>
                Bind the runner to this project — runner bindings are per project, managed from
                the{' '}
                <Link href="/runners" className="text-accent hover:underline">
                  Runners
                </Link>{' '}
                page.
              </li>
            </ol>
          </div>

          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            {seedResult ? (
              <Button type="button" variant="primary" onClick={finish}>
                Go to project
              </Button>
            ) : (
              <Button type="button" variant="ghost" onClick={finish} disabled={seeding}>
                Skip for now
              </Button>
            )}
          </div>
        </div>
      ) : (
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

          {teamOrgs.length > 0 && (
            <Field label="Organization" hint="Where this project lives. Org owners/admins manage all of its projects.">
              <Select
                value={orgId}
                onChange={(v) => setOrgId(v)}
                options={[
                  { value: '', label: 'Personal' },
                  ...teamOrgs.map((o) => ({ value: o.id, label: o.name })),
                ]}
              />
            </Field>
          )}

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
      )}
    </SlideOver>
  );
}
