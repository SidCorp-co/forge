'use client';


import { type FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Banner, Button, Field, Input, ReadFailedLine, Select, SlideOver, Textarea } from '@/design';
import { useActiveOrg } from '@/features/orgs/active-org';
import { useOrgs } from '@/features/orgs/hooks';
import { useUpdateProject } from '@/features/project-settings/hooks';
import type { ProjectUpdateInput } from '@/features/project-settings/types';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { useToast } from '@/providers/toast-provider';
import { SLUG_RE, slugify } from '@/lib/slug';
import { useCreateProject, useOnboardProject } from '../hooks';
import { REPOSITORY_PATH_HINT } from '../repository-path';
import type { CreatedProject } from '../types';

export { slugify };

/** The refused-repository toast, put away once the person edits the path it stands over. */
const REFUSED_SLOT = 'new-project-repository-refused';
/** The path field that toast tells the person to correct, which it keeps clear of. */
const PATH_FIELD_ID = 'new-project-repository-path';
/** The step's inline error and its Save button, which that toast keeps clear of too. */
const SEED_ERROR_ID = 'new-project-repository-error';
const SAVE_ID = 'new-project-repository-save';

/** The path field and its label: what greets the step, which the "Project created" toast keeps clear of. */
const pathField = () => [
  document.getElementById(PATH_FIELD_ID),
  document.querySelector(`label[for="${PATH_FIELD_ID}"]`),
];
/** What the refusal toast keeps clear of: the path field first, which it never covers, then its label,
 *  the inline error and Save, let go from the last where a short screen leaves no room (ISS-1236 r10). */
const repositoryStep = () => [
  ...pathField(),
  document.getElementById(SEED_ERROR_ID),
  document.getElementById(SAVE_ID),
];

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewProjectDialog({ open, onClose }: NewProjectDialogProps) {
  const router = useRouter();
  const { toast, dismiss } = useToast();
  const create = useCreateProject();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  // Target org — '' = the caller's personal org (server default). Until the person picks one it is the
  // active org (ISS-470), read whenever the organizations answer, a Retry's answer included (ISS-1229 r49).
  const [chosenOrgId, setChosenOrgId] = useState<string | null>(null);
  const orgsQ = useOrgs();
  const teamOrgs = (orgsQ.data ?? []).filter((o) => !o.isPersonal);
  const orgsUnread = orgsQ.isError && !orgsQ.data;
  const { activeOrg, scopeRead } = useActiveOrg();
  // Until the organizations and the stored active choice are read, where the project lands is unknown:
  // nothing is created before then.
  const orgsKnown = orgsQ.data !== undefined && scopeRead;
  const defaultOrgId = activeOrg && !activeOrg.isPersonal ? activeOrg.id : '';
  const orgId = chosenOrgId ?? defaultOrgId;
  const [errors, setErrors] = useState<{ name?: string; slug?: string; form?: string }>({});

  // Step 2 — "Set up pipeline" (ISS-453). `created` non-null flips the wizard.
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [repoSaved, setRepoSaved] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  // The refusal toast is the dialog's own: only it knows the project already exists (ISS-1236 r7).
  const update = useUpdateProject(created?.id, { toastFailure: false });
  const onboard = useOnboardProject(created?.id);

  // Reset the whole form each time the dialog opens — never leak a prior draft
  // or stale error into a fresh create.
  useEffect(() => {
    if (open) {
      setName('');
      setSlug('');
      setSlugEdited(false);
      setDescription('');
      setChosenOrgId(null);
      setErrors({});
      setCreated(null);
      setRepoPath('');
      setBaseBranch('main');
      setRepoSaved(false);
      setSeedError(null);
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
    if (!orgsKnown) return;
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
      toast({ title: 'Project created', description: row.name, tone: 'success', clearOf: pathField });
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
   * Save the repo fields through the existing project PATCH. Nothing else is
   * provisioned here.
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
      if (Object.keys(patch).length > 0) await update.mutateAsync(patch);

      setRepoSaved(true);
    } catch (err) {
      const said = formatApiError(err);
      setSeedError(said);
      // The fields are in front of the reader, so the toast says to fix them here; Settings is for later.
      toast({
        title: 'Project created; its repository settings were not saved',
        description: `${/[.!?]$/.test(said) ? said : `${said}.`} Correct them here and save again.`,
        tone: 'error',
        slot: REFUSED_SLOT,
        clearOf: repositoryStep,
        link: {
          label: 'Or set them later in Settings, on Shape & release',
          href: `/projects/${created.slug}/settings?tab=shape#repository`,
        },
      });
    }
  }

  const seeding = update.isPending;

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
          {seedError && (
            <div id={SEED_ERROR_ID}>
              <Banner tone="danger">{seedError}</Banner>
            </div>
          )}
          {repoSaved && <Banner tone="success">Repository settings saved.</Banner>}

          <Field
            label="Repository path"
            htmlFor={PATH_FIELD_ID}
            hint={REPOSITORY_PATH_HINT}
          >
            <Input
              value={repoPath}
              onChange={(e) => {
                setRepoPath(e.target.value);
                dismiss(REFUSED_SLOT);
              }}
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

          <div>
            <Button
              id={SAVE_ID}
              variant="primary"
              loading={seeding}
              onClick={onSeed}
              className="min-h-11"
            >
              Save repository settings
            </Button>
            <p className="fg-body-sm mt-1.5 text-subtle">
              Safe to re-run; everything stays editable in Settings.
            </p>
          </div>

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

          {repoSaved && (
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
          )}

          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            {repoSaved ? (
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

          {orgsUnread && (
            <ReadFailedLine
              testId="new-project-orgs-unread"
              what="your organizations, so where this project will live is not known"
              why={formatApiError(orgsQ.error)}
              onRetry={() => void orgsQ.refetch()}
            />
          )}
          {teamOrgs.length > 0 && (
            <Field label="Organization" hint="Where this project lives. Org owners/admins manage all of its projects.">
              <Select
                value={orgId}
                onChange={(v) => setChosenOrgId(v)}
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
            <Button type="submit" variant="primary" icon="plus" loading={create.isPending} disabled={!orgsKnown}>
              Create project
            </Button>
          </div>
        </form>
      )}
    </SlideOver>
  );
}
