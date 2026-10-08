import type { Metadata } from "next";
import { SharedAnswerPage } from "@/features/shares";

// A share link's page: one frozen answer, read-only, outside the workspace shell, with no navigation
// into the project. It is never indexed and never names itself to the next page it links to.
export const metadata: Metadata = {
  title: "Shared answer — Forge",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Params = { params: Promise<{ token: string }> };

export default async function SharePage({ params }: Params) {
  const { token } = await params;
  return <SharedAnswerPage token={token} />;
}
