"use client";

import { SharedReleaseView } from "@/features/releases/components/shared-release";
import { SharedAnswer } from "@/features/shares";
import { useAuth } from "@/providers/auth-provider";

// the route joins the two readers a share can open: a frozen answer (shares) and a frozen release page
// (releases), which sits above shares and so is handed in here rather than imported there
export function ShareBody({ token }: { token: string }) {
  const { user, isLoading } = useAuth();
  return (
    <div className="min-h-dvh bg-app">
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <SharedAnswer
          token={token}
          signedIn={isLoading ? null : user !== null}
          release={(snapshot) => <SharedReleaseView snapshot={snapshot} />}
        />
      </main>
    </div>
  );
}
