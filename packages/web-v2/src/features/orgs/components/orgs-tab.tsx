"use client";

import { Badge, Button, PageSection, PageSectionBody, ErrorState, Field, Input, SectionTitle, Skeleton, EnumBadge } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { SLUG_RE, slugify } from "@/lib/slug";
import { useToast } from "@/providers/toast-provider";
import { useCopy } from "@/lib/i18n/interface-language";
// Settings → Organizations. List the caller's orgs (personal pinned first),
// create a team org, and manage members of the selected org. Org owner/admin
// get implicit project-admin on every project of the org; plain org members
// still need a per-project invite — mirror that in the helper copy.
import { useState } from "react";
import { useCreateOrg, useOrgs } from "../hooks";
import { OrgMembersCard } from "./org-members-card";

export function OrgsTab() {
  const orgsQ = useOrgs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const t = useCopy();

  if (orgsQ.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-3/4 rounded-md" />
      </div>
    );
  }
  if (orgsQ.isError) {
    return (
      <ErrorState
        message={formatApiError(orgsQ.error)}
        onRetry={() => orgsQ.refetch()}
      />
    );
  }

  const orgs = [...(orgsQ.data ?? [])].sort(
    (a, b) =>
      Number(b.isPersonal) - Number(a.isPersonal) ||
      a.name.localeCompare(b.name),
  );
  const selected = orgs.find((o) => o.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <PageSection>
        <PageSectionBody>
          <SectionTitle className="fg-h3 mb-1">{t("settings.orgs.title")}</SectionTitle>
          <p className="fg-body-sm mb-4 text-muted">{t("settings.orgs.intro")}</p>
          <ul className="divide-y divide-line-subtle">
            {orgs.map((o) => (
              <li
                key={o.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-fg">
                  {o.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {o.isPersonal && <Badge tone="neutral">{t("overview.personal")}</Badge>}
                  <EnumBadge family="role" value={o.role} />
                  {!o.isPersonal && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setSelectedId(o.id === selectedId ? null : o.id)
                      }
                    >
                      {o.id === selectedId ? t("settings.orgs.close") : t("settings.orgs.members")}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <CreateOrgForm />
        </PageSectionBody>
      </PageSection>

      {selected && (
        <OrgMembersCard
          org={selected}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function CreateOrgForm() {
  const create = useCreateOrg();
  const submitting = useSubmitGuard();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState<string | undefined>(undefined);
  const t = useCopy();

  // Mirror the name into the slug until the user takes manual control.
  const onNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };
  const onSlugChange = (value: string) => {
    setSlugEdited(true);
    setSlug(value);
    if (slugError) setSlugError(undefined);
  };

  function validateSlug(value: string): string | undefined {
    if (value.length < 3) return t("settings.orgs.slugShort");
    if (value.length > 64) return t("settings.orgs.slugLong");
    if (!SLUG_RE.test(value)) return t("settings.orgs.slugChars");
    return undefined;
  }

  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmedName = name.trim();
        const trimmedSlug = slug.trim();
        const err = validateSlug(trimmedSlug);
        if (err) {
          setSlugError(err);
          return;
        }
        setSlugError(undefined);
        if (!submitting.claim()) return;
        create.mutate(
          { name: trimmedName, slug: trimmedSlug },
          {
            onSuccess: () => {
              setName("");
              setSlug("");
              setSlugEdited(false);
              toast({ title: t("settings.orgs.created"), tone: "success" });
            },
            onError: (err) =>
              toast({
                title: t("settings.requestFailed"),
                description: formatApiError(err),
                tone: "error",
              }),
            onSettled: submitting.release,
          },
        );
      }}
    >
      <div className="min-w-48 flex-1">
        <Field label={t("settings.orgs.newName")}>
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Acme Inc"
          />
        </Field>
      </div>
      <div className="min-w-40">
        <Field label={t("settings.orgs.slug")} error={slugError}>
          <Input
            value={slug}
            onChange={(e) => onSlugChange(e.target.value)}
            placeholder="acme-inc"
            pattern="[a-z0-9-]{3,64}"
          />
        </Field>
      </div>
      <Button
        type="submit"
        disabled={!name.trim() || !slug.trim() || create.isPending}
      >
        {t("settings.orgs.create")}
      </Button>
    </form>
  );
}
