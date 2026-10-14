import { Banner, Button, Field, Input, RowItem, RowList, Spinner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useMemo, useState } from "react";
import { useGitLabRepositories, useTestIntegration, useUpdateProviderIntegration } from "../../hooks";
import type { GitLabRepository, IntegrationSummary } from "../../types";
import { text } from "../config-read";

/**
 * The repository a binding reaches, read off its effective config: the binding's own pick, or the
 * `projectPath` an older connection still carries for every project bound to it.
 */
export function gitlabRepositoryOf(config: Record<string, unknown>): string | null {
  return text(config, "projectPath");
}

/** The binding-tier config a pick writes: GitLab's path and its numeric id. */
export function gitlabBindingOf(repo: GitLabRepository): { projectPath: string; projectId: number } {
  return { projectPath: repo.pathWithNamespace, projectId: repo.id };
}

/**
 * The projects a GitLab connection's token can push to, as a flush list to pick one from. The
 * search filters what is listed as it is typed; Enter asks GitLab itself, for a token that reaches
 * more projects than one list holds.
 */
export function GitLabRepositoryField({
  projectId,
  connectionId,
  value,
  onPick,
}: {
  projectId: string;
  connectionId: string | undefined;
  value: string | null;
  onPick: (repo: GitLabRepository) => void;
}) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const repos = useGitLabRepositories(projectId, connectionId, asked);
  const t = useCopy();

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = repos.data?.repositories ?? [];
    return needle ? all.filter((r) => r.pathWithNamespace.toLowerCase().includes(needle)) : all;
  }, [repos.data, query]);

  return (
    <Field label={t("integrations.gitlab.repository")} required>
      <div className="flex flex-col gap-2">
        <Input
          icon="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setAsked(query.trim());
            }
          }}
          placeholder={t("integrations.gitlab.searchRepos")}
          aria-label={t("integrations.gitlab.searchRepos")}
        />
        {repos.isLoading ? (
          <Spinner />
        ) : repos.isError ? (
          <Banner tone="danger">{formatApiError(repos.error)}</Banner>
        ) : shown.length === 0 ? (
          <p className="fg-body-sm text-muted">{t("integrations.gitlab.noRepos")}</p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <RowList label={t("integrations.gitlab.repository")} testId="gitlab-repositories">
              {shown.map((r) => (
                <RowItem
                  key={r.id}
                  rowKey={r.pathWithNamespace}
                  title={<span className="font-mono">{r.pathWithNamespace}</span>}
                  facts={[
                    r.defaultBranch ? t("integrations.gitlab.defaultBranch", { branch: r.defaultBranch }) : t("integrations.gitlab.noBranch"),
                    `#${r.id}`,
                  ]}
                  selected={r.pathWithNamespace === value}
                  onClick={() => onPick(r)}
                />
              ))}
            </RowList>
          </div>
        )}
        {repos.data?.truncated && <p className="fg-body-sm text-subtle">{t("integrations.gitlab.truncated")}</p>}
      </div>
    </Field>
  );
}

/**
 * Pick or change the repository of a GitLab binding this project already holds. The pick is the
 * binding's own `projectPath` and `projectId`, so two projects on one connection each keep theirs.
 */
export function SetGitLabRepository({
  projectId,
  binding,
  onDone,
}: {
  projectId: string;
  binding: IntegrationSummary;
  onDone: (() => void) | null;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const [picked, setPicked] = useState<GitLabRepository | null>(null);
  const current = gitlabRepositoryOf(binding.config);
  const t = useCopy();

  const save = () => {
    if (!picked) return;
    update.mutate(
      { id: binding.id, body: { config: gitlabBindingOf(picked), ...(binding.bindingActive ? {} : { active: true }) } },
      {
        // the binding's health was last read without a repository: read it again against the pick
        onSuccess: () => {
          test.mutate(binding.id);
          onDone?.();
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="gitlab-pick-repository">
      <GitLabRepositoryField
        projectId={projectId}
        connectionId={binding.connectionId}
        value={picked?.pathWithNamespace ?? current}
        onPick={setPicked}
      />
      {update.isError && <Banner tone="danger">{formatApiError(update.error)}</Banner>}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} loading={update.isPending} disabled={!picked || picked.pathWithNamespace === current}>
          {t("integrations.gitlab.saveRepo")}
        </Button>
        {onDone && (
          <Button variant="ghost" size="sm" onClick={onDone}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
