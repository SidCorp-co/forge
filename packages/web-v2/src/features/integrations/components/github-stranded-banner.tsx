// FB-128 — what GitHub's return could not finish, read from `?github=<cause>`. By then GitHub has
// made the App, so the banner says so: the App by name and its own settings page where core could
// learn them, else where to find it. Nothing here is trusted as more than words: the cause selects
// a sentence, and the only link is built on github.com.

import { GITHUB_CONNECT_STRANDS, type GitHubConnectStrand } from "@forge/contracts/integrations";
import { Banner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/** The cause a query names, or null where it names none this build knows. */
export function strandOf(params: URLSearchParams): GitHubConnectStrand | null {
  const cause = params.get("github");
  return (GITHUB_CONNECT_STRANDS as readonly string[]).includes(cause ?? "") ? (cause as GitHubConnectStrand) : null;
}

/** The App's own settings page on github.com, or GitHub's list of Apps when the App was not named. */
export function strandedAppLink(params: URLSearchParams): { name: string | null; href: string } {
  const slug = params.get("app");
  const owner = params.get("appOwner");
  if (!slug || !NAME.test(slug)) return { name: null, href: "https://github.com/settings/apps" };
  const app = encodeURIComponent(slug);
  const href =
    params.get("appOrg") === "1" && owner && NAME.test(owner)
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/${app}`
      : `https://github.com/settings/apps/${app}`;
  return { name: slug, href };
}

export function GitHubStrandedBanner({ params, onDismiss }: { params: URLSearchParams; onDismiss: () => void }) {
  const t = useCopy();
  const cause = strandOf(params);
  if (!cause) return null;
  const app = strandedAppLink(params);
  return (
    <div data-testid="github-stranded" className="flex flex-col gap-1">
      <Banner tone="danger" onDismiss={onDismiss}>
        <span className="font-semibold">{t(`integrations.github.stranded.${cause}`)}</span>{" "}
        {app.name ? t("integrations.github.stranded.named", { app: app.name }) : t("integrations.github.stranded.unnamed")}{" "}
        <a href={app.href} target="_blank" rel="noreferrer" className="font-semibold underline">
          {app.name ? t("integrations.github.stranded.openApp") : "github.com/settings/apps"}
        </a>
      </Banner>
    </div>
  );
}
