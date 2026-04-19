import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getAgents } from "@/lib/api";
import { AgentCard } from "@/components/agent-card";

export function ProjectAgents() {
  const { slug } = useParams<{ slug: string }>();
  const { data: agents, isLoading } = useQuery({
    queryKey: ["agents", slug],
    queryFn: () => getAgents(slug!),
    enabled: !!slug,
  });

  if (isLoading) return <p className="p-6 text-sm text-gray-500">Loading...</p>;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6">
        <h2 className="mb-1 text-xl font-bold text-gray-900">Agents</h2>
        <p className="text-sm text-gray-500">AI agents that automate project workflows.</p>
      </div>

      {agents?.map((agent) => (
        <AgentCard key={agent.documentId} agent={agent} slug={slug!} />
      ))}
    </div>
  );
}
