'use client';

import { Markdown } from '@/components/ui/markdown';
import type { Issue } from '@/features/issue/types';

interface IssueEnrichmentProps {
  issue: Issue;
}

export function IssueEnrichment({ issue }: IssueEnrichmentProps) {
  return (
    <>
      {issue.aiSummary && (
        <div className="overflow-hidden px-4 py-4 sm:px-6 space-y-1">
          <h3 className="text-sm font-semibold">AI Analysis</h3>
          <div className="text-sm text-on-surface-variant">
            <strong>Summary:</strong>
            <Markdown className="mt-0.5">{issue.aiSummary}</Markdown>
          </div>
          {issue.aiSuggestedSolution && (
            <div className="text-sm text-on-surface-variant">
              <strong>AI-Suggested Solution:</strong>
              <Markdown className="mt-0.5">{issue.aiSuggestedSolution}</Markdown>
            </div>
          )}
          {issue.aiAcceptanceCriteria && issue.aiAcceptanceCriteria.length > 0 && (
            <div>
              <strong className="text-sm">AI-Suggested Criteria:</strong>
              <ul className="mt-1 list-inside list-disc text-sm text-on-surface-variant">
                {issue.aiAcceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          {issue.aiConfidence != null && (
            <p className="text-xs text-outline">Confidence: {Math.round(issue.aiConfidence * 100)}%</p>
          )}
        </div>
      )}
    </>
  );
}
