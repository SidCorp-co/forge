import { ErrorState } from "@/design";

/**
 * Global 404. Renders OUTSIDE the (workspace) shell, so it is fully
 * self-contained (own centering + app background). The link resolves to `/`,
 * where web-v2 serves (ISS-397). The state is the whole page, so its title is
 * the page's heading and the tab's title (ISS-1229 r44).
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-app px-6 py-12">
      <ErrorState
        level={1}
        title="Page not found"
        message="This page moved or never existed. Go back to your home page to carry on."
        action={{ label: "Back to home", href: "/" }}
      />
    </div>
  );
}
