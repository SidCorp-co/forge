import { createFileRoute } from "@tanstack/react-router";
import { DesignGallery } from "./-design-gallery";

function DesignPage() {
  return <DesignGallery />;
}

export const Route = createFileRoute("/_workspace/dev/design/")({ component: DesignPage });
