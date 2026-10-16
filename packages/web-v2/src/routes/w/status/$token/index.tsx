import { createFileRoute } from "@tanstack/react-router";
import { WidgetStatusPage } from "@/features/widget";
import { productCopy } from "@/lib/i18n/product-copy";
import { useParams } from "@/lib/navigation/router";

// A visitor's private status link: public, read-only, never indexed, and its token in the path is
// carried on by no referrer.
function StatusLinkPage() {
  const { token } = useParams<{ token: string }>();
  return <WidgetStatusPage token={token} />;
}

export const Route = createFileRoute("/w/status/$token/")({
  head: () => ({
    meta: [
      { title: productCopy()("widget.meta.status") },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: StatusLinkPage,
});
