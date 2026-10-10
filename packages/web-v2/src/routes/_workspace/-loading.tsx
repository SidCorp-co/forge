import { ColdBoot } from "@/design/patterns/mascot-loaders";

/** What the workspace shows while its route loads. */
export function WorkspaceLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app">
      <ColdBoot />
    </div>
  );
}
