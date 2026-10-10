'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Banner, Button, Field, Input, Select, SlideOver } from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { useOrgs } from '@/features/orgs/hooks';
import { RUNNER_SETUP } from '@/features/runners/commands';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { useCopy } from '@/lib/i18n/interface-language';
import type { Copy } from '@/lib/i18n/product-copy';
import { SLUG_RE, slugify } from '@/lib/slug';
import { useSubmitGuard } from '@/lib/utils/use-submit-guard';
import { useToast } from '@/providers/toast-provider';
import { useAskForDesigns } from '@/features/onboarding/components/ask-for-designs';
import { useCreateProject } from '../hooks';
import type { CreatedProject } from '../types';

/** The command a person runs on the job machine to pair it: typed verbatim, so it is not copy. */

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useCopy();
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
      title={created ? t('projects.setup.title') : t('projects.new')}
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

function validate(t: Copy, name: string, slug: string) {
  const next: { name?: string; slug?: string } = {};
  if (name.length < 1) next.name = t('projects.form.nameRefused.missing');
  else if (name.length > 200) next.name = t('projects.form.nameRefused.long');
  if (slug.length < 3) next.slug = t('projects.form.slugRefused.short');
  else if (slug.length > 64) next.slug = t('projects.form.slugRefused.long');
  else if (!SLUG_RE.test(slug)) next.slug = t('projects.form.slugRefused.shape');
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
  const t = useCopy();
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
    const fieldErrors = validate(t, trimmedName, trimmedSlug);
    setErrors(fieldErrors);
    if (fieldErrors.name || fieldErrors.slug || !submitting.claim()) return;
    try {
      const row = await create.mutateAsync({ slug: trimmedSlug, name: trimmedName, ...(orgId ? { orgId } : {}) });
      toast({ title: t('projects.form.created'), description: row.name, tone: 'success' });
      // ISS-453 — don't navigate yet: advance to the "Set up pipeline" step.
      onCreated(row);
    } catch (err) {
      submitting.release();
      // A taken slug is a field-level problem; everything else is a form banner.
      setErrors(
        err instanceof ApiError && err.code === 'SLUG_TAKEN'
          ? { slug: t('projects.form.slugRefused.taken') }
          : { form: formatApiError(err) },
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex h-full flex-col gap-4">
      {errors.form && <Banner tone="danger">{errors.form}</Banner>}
      <Field label={t('projects.form.name')} required error={errors.name}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            // Mirror the name into the slug until the user takes manual control.
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
          placeholder={t('projects.form.namePlaceholder')}
          autoFocus
          maxLength={200}
        />
      </Field>
      <Field label={t('projects.form.slug')} required error={errors.slug}>
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
        <Field label={t('projects.form.org')}>
          <Select
            value={orgId}
            onChange={setOrgId}
            options={[{ value: '', label: t('projects.form.personal') }, ...teamOrgs.map((o) => ({ value: o.id, label: o.name }))]}
          />
        </Field>
      )}
      <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" icon="plus" loading={create.isPending}>
          {t('projects.form.create')}
        </Button>
      </div>
    </form>
  );
}

function SetupPipeline({ created, onFinish }: { created: CreatedProject; onFinish: () => void }) {
  /** The designed onboarding: confirm what its job does, start it, open its thread, land on the project. */
  const onboarding = useAskForDesigns(created.id, { onOpened: onFinish });
  const onboardError = onboarding.error;
  const t = useCopy();

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <span className="fg-label">{t('projects.setup.runner')}</span>
        <ol className="fg-body-sm mt-2 list-decimal space-y-1.5 pl-5 text-subtle">
          <li>
            {t('projects.setup.pair')} <code className="font-mono text-13 text-fg">{RUNNER_SETUP}</code>
          </li>
          <li>
            {t('projects.setup.assign')}{' '}
            <Link href="/runners" className="text-accent hover:underline">
              {t('projects.setup.runners')}
            </Link>
          </li>
        </ol>
      </div>
      <div className="border-t border-line-subtle pt-4">
        <span className="fg-label">{t('projects.setup.onboard')}</span>
        {onboardError && (
          <div className="mt-2">
            <Banner tone="danger">{onboardError}</Banner>
          </div>
        )}
        <div className="mt-2">
          <Button variant="secondary" loading={onboarding.pending} onClick={() => onboarding.ask('start')} className="min-h-11">
            {t('projects.setup.askDesigns')}
          </Button>
          {onboarding.dialog}
        </div>
      </div>
      <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
        <Button type="button" variant="primary" onClick={onFinish}>
          {t('projects.setup.open')}
        </Button>
      </div>
    </div>
  );
}
