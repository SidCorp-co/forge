import { createFileRoute } from "@tanstack/react-router";
import { productCopy } from "@/lib/i18n/product-copy";
import { useParams } from "@/lib/navigation/router";
import { ShareBody } from "./-share-body";

// A share link's page: one frozen answer, read-only, outside the workspace shell, with no navigation
// into the project. It is never indexed, and core serves it with `Referrer-Policy: no-referrer`.
function SharePage() {
  const { token } = useParams<{ token: string }>();
  return <ShareBody token={token} />;
}

export const Route = createFileRoute("/s/$token/")({
  head: () => ({
    meta: [
      { title: productCopy()("common.meta.sharedAnswer") },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: SharePage,
});
