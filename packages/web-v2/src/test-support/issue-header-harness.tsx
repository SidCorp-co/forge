// The issue page's sticky header as the page draws it, at a realistic title and toolbar (the real
// HelpButton; the actions IssueHeaderActions draws, which needs the app router to mount). `location.hash`
// is "none", "failed" (a failed read on the header's own line) or "in-toolbar" (the same sentence
// where round 23 drew it, inside the actions), so a test measures the layout each one gives.
import "./process-shim"; // next/link, under the design Button, reads `process.env` as it loads
import { createRoot } from "react-dom/client";
import { HeaderReadFailure, IssueStickyHeader } from "@/features/issues/components/issue-sticky-header";
import { Button } from "@/design/primitives/button";
import { HelpButton } from "@/design/primitives/help-button";
import { IconButton } from "@/design/primitives/icon-button";
import { MonoTag } from "@/design/primitives/mono-tag";

const TITLE = "Checkout keeps the old shipping address after the customer edits it on the review step";
const scenario = decodeURIComponent(location.hash.slice(1));
const failed = (
<HeaderReadFailure said="Its session could not be read. Not a project member." retry={() => undefined} />
);

createRoot(document.getElementById("root") as HTMLElement).render(
  <div className="px-4 sm:px-8">
    <IssueStickyHeader
      onBack={() => undefined}
      chips={<MonoTag hue="cobalt">ISS-1</MonoTag>}
      title={TITLE}
      actions={
        <>
          <HelpButton compact summary="The full record for one issue." actions={["Run, pause or reopen it from the header"]} />
          <Button variant="primary" size="sm" icon="pipeline">
            Open pipeline
          </Button>
          {scenario === "in-toolbar" && failed}
          <IconButton icon="more" aria-label="Issue actions" />
        </>
      }
      failure={scenario === "failed" ? failed : null}
    />
  </div>,
);

Promise.all([
  document.fonts.load('400 15px "Hanken Grotesk"'),
  document.fonts.load('600 15px "Hanken Grotesk"'),
  new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
]).then(() => {
  (window as unknown as { ready: boolean }).ready = true;
});
