import { redirect } from "next/navigation";

// The address before Automation became one page with tabs (ISS-65); a saved link lands on its tab.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/projects/${encodeURIComponent(slug)}/automation?tab=improvements`);
}
