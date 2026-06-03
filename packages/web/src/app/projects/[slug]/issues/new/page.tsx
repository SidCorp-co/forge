import { redirect } from 'next/navigation';

// Legacy v1 create-issue form is retired — hand off to the web-v2 Issues
// screen, which auto-opens its create slide-over on `?new=1` (see
// web-v2 issues-screen.tsx). Full-document redirect to cross into the /v2 app.
export default async function NewIssueRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/v2/projects/${slug}/issues?new=1`);
}
