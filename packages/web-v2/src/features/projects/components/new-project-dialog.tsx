'use client';


import { type FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Banner, Button, Field, Input, Select, SlideOver } from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { useOrgs } from '@/features/orgs/hooks';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { useToast } from '@/providers/toast-provider';
import { SLUG_RE, slugify } from '@/lib/slug';
import { useCreateProject, useOnboardProject } from '../hooks';
import type { CreatedProject } from '../types';

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
  // Target org — '' = the caller's personal org (server default). Defaults to
  // the active org (ISS-470): a team org preselects its id, Personal → ''.
  const [orgId, setOrgId] = useState('');
  const orgsQ = useOrgs();
  const teamOrgs = (orgsQ.data ?? []).filter((o) => !o.isPersonal);
  const { activeOrg } = useActiveOrg();
  const defaultOrgId = activeOrg && !activeOrg.isPersonal ? activeOrg.id : '';
  const [errors, setErrors] = useState<{ name?: string; slug?: string; form?: string }>({});

  // Step 2 — "Set up pipeline" (ISS-453). `created` non-null flips the wizard.
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const onboard = useOnboardProject(created?.id);

  // Reset the whole form each time the dialog opens — never leak a prior draft
  // or stale error into a fresh create.
  useEffect(() => {
    if (open) {
      setName('');
      setSlug('');
      setSlugEdited(false);
      setOrgId(defaultOrgId);
      setErrors({});
      setCreated(null);
      setOnboardError(null);
      create.reset();
    }
    // `create` is stable from React Query; resetting only on `open` is intended.
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

    try {
      const row = await create.mutateAsync({
        slug: trimmedSlug,
        name: trimmedName,
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
   * ISS-733 — "Build Project Brain": open a fresh chat session that runs
   * `forge-onboard` as turn 1, then jump straight to it (same detail route a
   * chat notification/history entry would open — no new UI surface).
   */
  async function onBuildBrain() {
    if (!created) return;
    setOnboardError(null);
    try {
      const result = await onboard.mutateAsync();
      toast({ title: 'Onboarding chat started', tone: 'success' });
      onClose();
      router.push(`/projects/${created.slug}/agents/${result.sessionId}`);
    } catch (err) {
      setOnboardError(formatApiError(err));
    }
  }

  return (
    <SlideOver
      open={open}
      onClose={created ? finish : onClose}
      title={created ? 'Set up pipeline' : 'New project'}
      width={460}
    >
      {created ? (
        <div className="flex h-full flex-col gap-4">
          <p className="fg-body-sm text-subtle">
            The repository, the branch work is cut from and where it lands are the project
            document&apos;s: declare them under Settings → Configuration.
          </p>

          <div className="border-t border-line-subtle pt-4">
            <span className="fg-label">Connect a runner</span>
            <ol className="fg-body-sm mt-2 list-decimal space-y-1.5 pl-5 text-subtle">
              <li>
                Run{' '}
                <code className="font-mono text-13 text-fg">forge-runner setup</code> on the
                machine that will execute jobs: it pairs the device, then waits for step 2.
              </li>
              <li>
                Assign the device to this project — assignments are per project, managed from
                the{' '}
                <Link href="/runners" className="text-accent hover:underline">
                  Runners
                </Link>{' '}
                page.
              </li>
            </ol>
          </div>

          <div className="border-t border-line-subtle pt-4">
            <span className="fg-label">Build the Project Brain</span>
            {onboardError && (
              <div className="mt-2">
                <Banner tone="danger">{onboardError}</Banner>
              </div>
            )}
            <div className="mt-2">
              <Button
                variant="secondary"
                loading={onboard.isPending}
                onClick={onBuildBrain}
                className="min-h-11"
              >
                Build Project Brain
              </Button>
              <p className="fg-body-sm mt-1.5 text-subtle">
                Opens a chat that surveys the repo and asks you a few questions to seed
                knowledge, memory, and pipeline config. Needs a runner bound to this project —
                connect one above first if this fails.
              </p>
            </div>
          </div>

          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            <Button type="button" variant="primary" onClick={finish}>
              Go to project
            </Button>
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
