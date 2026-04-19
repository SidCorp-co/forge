import { Link } from "react-router-dom";
import { AlertBanner } from "@/components/ui/alert-banner";

export function RepoWarning({ slug }: { slug: string }) {
  return (
    <div className="mx-6 mt-3">
      <AlertBanner variant="warning">
        Repo path not configured. <Link to={`/project/${slug}/settings`} className="underline">Settings</Link>
      </AlertBanner>
    </div>
  );
}
