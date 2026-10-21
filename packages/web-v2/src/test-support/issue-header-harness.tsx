// The issue page's sticky header as the page draws it, at a realistic title, with the production
// toolbar: HelpButton and IssueHeaderActions, mounted under a stub app router. `location.hash`
// is "none", "failed" (a failed read on the header's own line) or "in-toolbar" (the same sentence
// where round 23 drew it, inside the actions), so a test measures the layout each one gives.
import "./process-shim"; // next/link, under the design Button, reads `process.env` as it loads
import { createRoot } from "react-dom/client";
import { HeaderReadFailure, IssueStickyHeader } from "@/features/issues/components/issue-sticky-header";
import { HelpButton } from "@/design/primitives/help-button";
import { MonoTag } from "@/design/primitives/mono-tag";
import { IssueHeaderActions } from "@/features/issues/components/issue-header-actions";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

const TITLE = "Checkout keeps the old shipping address after the customer edits it on the review step";
const scenario = decodeURIComponent(location.hash.slice(1));
const failed = (
<HeaderReadFailure said="Its session could not be read. Not a project member." retry={() => undefined} />
);

const noop = () => undefined;
const router = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop, hmrRefresh: noop };

createRoot(document.getElementById("root") as HTMLElement).render(
  <AppRouterContext.Provider value={router as never}>
    <div className="px-4 sm:px-8">
      <IssueStickyHeader
        onBack={noop}
        chips={<MonoTag hue="cobalt">ISS-1</MonoTag>}
        title={TITLE}
        actions={
          <>
            <HelpButton compact summary="The full record for one issue." actions={["Run, pause or reopen it from the header"]} />
            <IssueHeaderActions
              slug="rig"
              sessionHref={null}
              status="in_progress"
              releaseRunId={null}
              canWrite
              pending={false}
              isRunActive
              onTransition={noop}
              onRun={noop}
              running={false}
              onCopyLink={noop}
            />
            {scenario === "in-toolbar" && failed}
          </>
        }
        failure={scenario === "failed" ? failed : null}
      />
    </div>
  </AppRouterContext.Provider>,
);

Promise.all([
  document.fonts.load('400 15px "Hanken Grotesk"'),
  document.fonts.load('600 15px "Hanken Grotesk"'),
  new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
]).then(() => {
  (window as unknown as { ready: boolean }).ready = true;
});
