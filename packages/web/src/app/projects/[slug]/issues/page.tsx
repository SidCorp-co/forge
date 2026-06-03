import { redirect } from 'next/navigation';

// Legacy v1 Issues list is retired — hand off to the redesigned web-v2
// Board/List/Insights experience mounted under the /v2 basePath (ISS-364).
// Server-component redirect() emits an HTTP 307; the browser re-requests the
// /v2 path, which the deployment routes to the web-v2 container. Crossing from
// v1 -> v2 must be a full document navigation, never the Next client router.
export default async function IssueListRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/v2/projects/${slug}/issues`);
}
