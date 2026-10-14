// Settings → Testing: the accounts a run signs in with, read per testing profile and the environment
// that uses it. Each account is one row: its role, where it is used, and whether its secret holds a
// value (never the value), with a write-only act to replace it. The profile's limits are short rows,
// and its raw document sits behind a fold for whoever edits it.
import { releaseRowHeadline } from "@forge/contracts/release-digest";
import { useState } from "react";
import { Button, Disclosure, ErrorState, RowItem, RowList, SettingsGroup, Skeleton, sentenceCase } from "@/design";
import { useProjectDocument, useSecretNames, useTestingProfiles } from "@/features/project-config";
import type { V1Read } from "@/features/project-config";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { NewTestingProfile, TestingProfileDocument } from "./config-documents";
import { ReplaceSecret, SecretForm } from "./secrets-section";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const SECRET_REF = /^secret:\/\/([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/;
const MASK = "••••••••";

/** A stored secret as core lists it: its name and when its value was last written, never the value. */
interface SecretName {
  ref: string;
  updatedAt: string;
}

/** The environments whose `testing` names each profile, read off the project document. */
function environmentsByProfile(project: V1Read | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const envs = obj(project?.declared ? project.document.environments : undefined);
  for (const [name, env] of Object.entries(envs)) {
    const profile = str(obj(env).testing);
    if (profile) out.set(profile, [...(out.get(profile) ?? []), name]);
  }
  return out;
}

/** One credential a profile names: an actor who signs in, or a service it calls. */
function CredentialLine({
  projectId,
  name,
  kind,
  credential,
  usedIn,
  stored,
  canEdit,
}: {
  projectId: string;
  name: string;
  kind: string;
  credential: string;
  usedIn: string[];
  stored: ReadonlyMap<string, SecretName> | null;
  canEdit: boolean;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  const [replacing, setReplacing] = useState(false);
  const ref = SECRET_REF.exec(credential);
  const held = stored?.get(credential);
  const standing =
    stored === null
      ? t("settings.project.testing.reading")
      : held
        ? t("settings.project.testing.valueSet", { at: time.date(held.updatedAt) })
        : t("settings.project.testing.valueMissing");
  return (
    <RowItem
      lead={<span translate="no">{name}</span>}
      title={kind}
      facts={[
        usedIn.length > 0 ? t("settings.project.testing.usedIn", { envs: usedIn.join(", ") }) : t("settings.project.testing.usedNowhere"),
        standing,
      ]}
      trailing={
        <span className="flex items-center gap-3">
          <span className={held ? "font-mono text-13 text-muted" : "text-13 font-medium text-warn-11"} aria-label={standing}>
            {held ? MASK : t("settings.project.testing.notSet")}
          </span>
          {canEdit && ref?.[1] && ref[2] && !replacing ? (
            <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>
              {held ? t("settings.project.testing.replace") : t("settings.project.testing.setValue")}
            </Button>
          ) : null}
        </span>
      }
      testId="testing-credential"
      rowKey={`${name}:${credential}`}
    >
      {replacing && ref?.[1] && ref[2] ? <ReplaceSecret projectId={projectId} scope={ref[1]} name={ref[2]} onDone={() => setReplacing(false)} /> : null}
    </RowItem>
  );
}

/** A limit the profile declares, said by its note in at most fifteen words, the rest one click away;
 *  its id is the raw document's. */
function LimitLine({ id, note }: { id: string; note: string }) {
  const [open, setOpen] = useState(false);
  const head = releaseRowHeadline(note);
  return <RowItem wrap expanded={open} onClick={head.cut ? () => setOpen((o) => !o) : undefined} title={open ? note : head.text} testId="testing-limit" rowKey={id} />;
}

function ProfileAccounts({
  projectId,
  profileId,
  read,
  usedIn,
  stored,
  canEdit,
  onReload,
}: {
  projectId: string;
  profileId: string;
  read: V1Read | null;
  usedIn: string[];
  stored: ReadonlyMap<string, SecretName> | null;
  canEdit: boolean;
  onReload: () => unknown;
}) {
  const t = useCopy();
  const doc = read?.declared ? read.document : {};
  const actors = Object.entries(obj(doc.actors)).map(([name, a]) => ({ name, role: str(obj(a).role), credential: str(obj(a).credential) }));
  const services = Object.entries(obj(doc.services)).map(([name, s]) => ({ name, access: str(obj(s).access), credential: str(obj(s).credential), endpoint: str(obj(s).endpoint) }));
  const limits = (Array.isArray(doc.limits) ? doc.limits : []).map((l) => ({ id: str(obj(l).id), note: str(obj(l).note) }));
  return (
    <section id={`profile-${profileId}`} aria-label={t("settings.project.testing.profileNamed", { id: profileId })} className="scroll-mt-24 space-y-4 border-t border-line-subtle pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="fg-h4 text-fg">{t("settings.project.testing.profileNamed", { id: profileId })}</h4>
        <span className="text-13 text-muted">
          {usedIn.length > 0 ? t("settings.project.testing.forEnvironments", { envs: usedIn.join(", ") }) : t("settings.project.testing.noEnvironment")}
        </span>
      </div>
      {actors.length + services.length === 0 ? (
        <p className="text-13 text-muted">{t("settings.project.testing.noAccounts")}</p>
      ) : (
        <RowList label={t("settings.project.testing.accounts")}>
          {actors.map((a) => (
            <CredentialLine key={a.name} projectId={projectId} name={a.name} kind={sentenceCase(a.role.replace(/-/g, " "))} credential={a.credential} usedIn={usedIn} stored={stored} canEdit={canEdit} />
          ))}
          {services.map((s) => (
            <CredentialLine
              key={`service:${s.name}`}
              projectId={projectId}
              name={s.name}
              kind={t(s.access === "readwrite" ? "settings.project.testing.serviceReadWrite" : "settings.project.testing.serviceReadOnly")}
              credential={s.credential}
              usedIn={usedIn}
              stored={stored}
              canEdit={canEdit}
            />
          ))}
        </RowList>
      )}
      {limits.length > 0 ? (
        <div>
          <h5 className="mb-1 text-12-5 font-medium text-muted">{t("settings.project.testing.limits")}</h5>
          <RowList label={t("settings.project.testing.limits")}>
            {limits.map((l) => (
              <LimitLine key={l.id} id={l.id} note={l.note} />
            ))}
          </RowList>
        </div>
      ) : null}
      <Disclosure title={t("settings.project.raw.document")} summary={read?.declared ? t("settings.project.raw.revision", { revision: read.revision }) : t("settings.project.raw.unsaved")} defaultOpen={!read}>
        <TestingProfileDocument projectId={projectId} profileId={profileId} read={read} canEdit={canEdit} onReload={onReload} />
      </Disclosure>
    </section>
  );
}

export function TestingSettings({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const t = useCopy();
  const profiles = useTestingProfiles(projectId);
  const secrets = useSecretNames(projectId);
  const project = useProjectDocument(projectId);
  const [adding, setAdding] = useState<string[]>([]);
  if (profiles.isLoading) return <Skeleton className="h-64 w-full rounded-md" />;
  if (!profiles.data) return <ErrorState message={formatApiError(profiles.error)} onRetry={() => void profiles.refetch()} />;
  const byProfile = environmentsByProfile(project.data);
  const stored = secrets.data ? new Map(secrets.data.secrets.map((s) => [s.ref, s])) : null;
  const held = new Set(profiles.data.profiles.map((p) => p.profileId));
  const pending = adding.filter((id) => !held.has(id));
  const named = new Set(
    profiles.data.profiles.flatMap((p) => [...Object.values(obj(p.document.actors)), ...Object.values(obj(p.document.services))].map((c) => str(obj(c).credential))),
  );
  const unused = (secrets.data?.secrets ?? []).filter((s) => !named.has(s.ref));
  return (
    <div>
      <SettingsGroup id="test-accounts" title={t("settings.project.testing.title")} summary={t("settings.project.testing.summary")}>
        {profiles.data.profiles.length + pending.length === 0 ? <p className="fg-body-sm text-muted">{t("settings.project.raw.noProfiles")}</p> : null}
        {profiles.data.profiles.map((p) => (
          <ProfileAccounts key={p.profileId} projectId={projectId} profileId={p.profileId} read={p} usedIn={byProfile.get(p.profileId) ?? []} stored={stored} canEdit={canEdit} onReload={() => profiles.refetch()} />
        ))}
        {pending.map((id) => (
          <ProfileAccounts key={id} projectId={projectId} profileId={id} read={null} usedIn={byProfile.get(id) ?? []} stored={stored} canEdit={canEdit} onReload={() => profiles.refetch()} />
        ))}
        {canEdit ? <NewTestingProfile held={held} onAdd={(id) => setAdding((a) => [...a, id])} /> : null}
      </SettingsGroup>
      <SettingsGroup id="secrets" title={t("settings.project.testing.otherSecrets")}>
        {secrets.isError ? <p className="fg-body-sm text-danger-11">{t("settings.project.raw.secretsUnread", { error: formatApiError(secrets.error) })}</p> : null}
        {unused.length > 0 ? (
          <RowList label={t("settings.project.testing.otherSecrets")}>
            {unused.map((s) => (
              <RowItem key={s.ref} title={<span translate="no">{s.ref}</span>} facts={[t("settings.project.testing.valueSet", { at: s.updatedAt.slice(0, 10) }), t("settings.project.testing.usedNowhere")]} />
            ))}
          </RowList>
        ) : (
          <p className="fg-body-sm text-muted">{t("settings.project.testing.noOtherSecrets")}</p>
        )}
        {canEdit ? (
          <Disclosure title={t("settings.project.testing.storeAnother")}>
            <SecretForm projectId={projectId} />
          </Disclosure>
        ) : null}
      </SettingsGroup>
    </div>
  );
}
