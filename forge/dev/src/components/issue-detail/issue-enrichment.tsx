import type { Issue } from "@/lib/types";
import { Markdown } from "../ui/markdown";

interface Props {
  issue: Issue;
}

export function IssueEnrichment({ issue }: Props) {
  return (
    <>
      {/* Agent Plan */}
      {issue.plan && (
        <div className="px-6 py-3">
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Implementation Plan</h3>
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
            <Markdown>{issue.plan}</Markdown>
          </div>
        </div>
      )}

      {/* AI Enrichment */}
      {issue.aiSummary && (
        <div className="px-6 py-4 space-y-1">
          <h3 className="text-sm font-semibold text-gray-900">AI Analysis</h3>
          <div className="text-sm text-gray-600">
            <strong>Summary:</strong>
            <div className="mt-0.5"><Markdown>{issue.aiSummary}</Markdown></div>
          </div>
          {issue.aiSuggestedSolution && (
            <div className="text-sm text-gray-600">
              <strong>AI-Suggested Solution:</strong>
              <div className="mt-0.5"><Markdown>{issue.aiSuggestedSolution}</Markdown></div>
            </div>
          )}
          {issue.aiAcceptanceCriteria && issue.aiAcceptanceCriteria.length > 0 && (
            <div>
              <strong className="text-sm">AI-Suggested Criteria:</strong>
              <ul className="mt-1 list-inside list-disc text-sm text-gray-600">
                {issue.aiAcceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          {issue.aiConfidence != null && (
            <p className="text-xs text-gray-400">Confidence: {Math.round(issue.aiConfidence * 100)}%</p>
          )}
        </div>
      )}
    </>
  );
}
