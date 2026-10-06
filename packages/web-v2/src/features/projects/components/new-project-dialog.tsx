'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Banner, Button, Field, Input, Select, SlideOver } from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { useOrgs } from '@/features/orgs/hooks';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { SLUG_RE, slugify } from '@/lib/slug';
import { useSubmitGuard } from '@/lib/utils/use-submit-guard';
import { useToast } from '@/providers/toast-provider';
import { useAskForDesigns } from '@/features/onboarding/components/ask-for-designs';
import { useCreateProject } from '../hooks';
import type { CreatedProject } from '../types';

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  // Step 2 — "Set up pipeline" (ISS-453). `created` non-null flips the wizard.
  const [created, setCreated] = useState<CreatedProject | null>(null);
  useEffect(() => {
    if (open) setCreated(null);
  }, [open]);

  /** Leave the wizard and land on the new project (step-2 exit, incl. ✕). */
  function finish() {
    if (!created) return;
    onClose();
    router.push(`/projects/${created.slug}`);
  }

  return (
    <SlideOver
      open={open}
      onClose={created ? finish : onClose}
      title={created ? 'Set up pipeline' : 'New project'}
      width={460}
    >
      {created ? (
        <SetupPipeline created={created} onFinish={finish} />
      ) : (
        <CreateProjectForm open={open} onCreated={setCreated} onClose={onClose} />
      )}
    </SlideOver>
  );
}

function validate(name: string, slug: string) {
  const next: { name?: string; slug?: string } = {};
  if (name.length < 1) next.name = 'Name is required.';
  else if (name.length > 200) next.name = 'Name must be 200 characters or fewer.';
  if (slug.length < 3) next.slug = 'Slug must be at least 3 characters.';
  else if (slug.length > 64) next.slug = 'Slug must be 64 characters or fewer.';
  else if (!SLUG_RE.test(slug)) next.slug = 'Slug may use lowercase letters, digits, and hyphens only.';
  return next;
}

function CreateProjectForm({
  open,
  onCreated,
  onClose,
}: {
  open: boolean;
  onCreated: (row: CreatedProject) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateProject();
  const submitting = useSubmitGuard();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  // Target org — '' = the caller's personal org (server default). Defaults to
  // the active org (ISS-470): a team org preselects its id, Personal → ''.
  const [orgId, setOrgId] = useState('');
  const teamOrgs = (useOrgs().data ?? []).filter((o) => !o.isPersonal);
  const { activeOrg } = useActiveOrg();
  const defaultOrgId = activeOrg && !activeOrg.isPersonal ? activeOrg.id : '';
  const [errors, setErrors] = useState<{ name?: string; slug?: string; form?: string }>({});

  // Reset the whole form each time the dialog opens — never leak a prior draft
  // or stale error into a fresh create.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets only when the dialog opens; `create` and `defaultOrgId` are read at that moment.
  useEffect(() => {
    if (open) {
      setName('');
      setSlug('');
      setSlugEdited(false);
      setOrgId(defaultOrgId);
      setErrors({});
      create.reset();
      submitting.release();
    }
  }, [open, submitting]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    const fieldErrors = validate(trimmedName, trimmedSlug);
    setErrors(fieldErrors);
    if (fieldErrors.name || fieldErrors.slug || !submitting.claim()) return;
    try {
      const row = await create.mutateAsync({ slug: trimmedSlug, name: trimmedName, ...(orgId ? { orgId } : {}) });
      toast({ title: 'Project created', description: row.name, tone: 'success' });
      // ISS-453 — don't navigate yet: advance to the "Set up pipeline" step.
      onCreated(row);
    } catch (err) {
      submitting.release();
      // A taken slug is a field-level problem; everything else is a form banner.
      setErrors(
        err instanceof ApiError && err.code === 'SLUG_TAKEN'
          ? { slug: 'That slug is already taken.' }
          : { form: formatApiError(err) },
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex h-full flex-col gap-4">
      {errors.form && <Banner tone="danger">{errors.form}</Banner>}
      <Field label="Name" required error={errors.name}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            // Mirror the name into the slug until the user takes manual control.
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
          placeholder="Acme Platform"
          autoFocus
          maxLength={200}
        />
      </Field>
      <Field label="Slug" required error={errors.slug} hint="Used in URLs. Lowercase letters, digits, and hyphens.">
        <Input
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
          placeholder="acme-platform"
          maxLength={64}
        />
      </Field>
      {teamOrgs.length > 0 && (
        <Field label="Organization" hint="Where this project lives. Org owners/admins manage all of its projects.">
          <Select
            value={orgId}
            onChange={setOrgId}
            options={[{ value: '', label: 'Personal' }, ...teamOrgs.map((o) => ({ value: o.id, label: o.name }))]}
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
  );
}

function SetupPipeline({ created, onFinish }: { created: CreatedProject; onFinish: () => void }) {
  /** The designed onboarding: confirm what its job does, start it, open its thread, land on the project. */
  const onboarding = useAskForDesigns(created.id, { onOpened: onFinish });
  const onboardError = onboarding.error;

  return (
    <div className="flex h-full flex-col gap-4">
      <p className="fg-body-sm text-subtle">
        The repository, the branch work is cut from and where it lands are the project document&apos;s:
        declare them under Settings → Configuration.
      </p>
      <div className="border-t border-line-subtle pt-4">
        <span className="fg-label">Connect a runner</span>
        <ol className="fg-body-sm mt-2 list-decimal space-y-1.5 pl-5 text-subtle">
          <li>
            Run <code className="font-mono text-13 text-fg">forge-runner setup</code> on the machine that
            will execute jobs: it pairs the device, then waits for step 2.
          </li>
          <li>
            Assign the device to this project — assignments are per project, managed from the{' '}
            <Link href="/runners" className="text-accent hover:underline">
              Runners
            </Link>{' '}
            page.
          </li>
        </ol>
      </div>
      <div className="border-t border-line-subtle pt-4">
        <span className="fg-label">Onboard the project</span>
        {onboardError && (
          <div className="mt-2">
            <Banner tone="danger">{onboardError}</Banner>
          </div>
        )}
        <div className="mt-2">
          <Button variant="secondary" loading={onboarding.pending} onClick={() => onboarding.ask('start')} className="min-h-11">
            Ask for designs
          </Button>
          {onboarding.dialog}
          <p className="fg-body-sm mt-1.5 text-subtle">
            Analyses the repository on a runner bound to this project, then asks you a few rounds of questions in
            the onboarding thread. Connect a runner above first.
          </p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
        <Button type="button" variant="primary" onClick={onFinish}>
          Go to project
        </Button>
      </div>
    </div>
  );
}
