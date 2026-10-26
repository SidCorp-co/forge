import { ErrorState } from "@/design";

/** Global 404, outside the workspace shell, so it centres itself on the app background. */
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
