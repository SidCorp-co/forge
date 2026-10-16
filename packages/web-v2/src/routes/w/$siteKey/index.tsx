import { createFileRoute } from "@tanstack/react-router";
import { WidgetFrame } from "@/features/widget";
import { productCopy } from "@/lib/i18n/product-copy";
import { useParams } from "@/lib/navigation/router";

// The page a client site's widget loader opens in its iframe: outside the workspace shell and any
// Forge session, since the visitor is the client's user, never a Forge one.
function WidgetFramePage() {
  const { siteKey } = useParams<{ siteKey: string }>();
  return <WidgetFrame siteKey={siteKey} />;
}

export const Route = createFileRoute("/w/$siteKey/")({
  head: () => ({
    meta: [{ title: productCopy()("widget.meta.frame") }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: WidgetFramePage,
});
