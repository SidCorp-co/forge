'use client';

import { Loader2, Play, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AgentActionsProps {
  hasReviewPrompt: boolean;
  hasReindexPrompt: boolean;
  desktopConnected: boolean;
  agentEnabled: boolean;
  poLoading: 'review' | 'reindex' | null;
  showConfig: boolean;
  onReview: () => void;
  onReindex: () => void;
  onToggleConfig: () => void;
}

export function AgentActions({
  hasReviewPrompt,
  hasReindexPrompt,
  desktopConnected,
  agentEnabled,
  poLoading,
  showConfig,
  onReview,
  onReindex,
  onToggleConfig,
}: AgentActionsProps) {
  return (
    <div className="flex items-center gap-2 border-t border-outline-variant/20 px-5 py-3">
      {hasReviewPrompt && (
        <Button
          size="xs"
          onClick={onReview}
          disabled={!desktopConnected || !agentEnabled || poLoading !== null}
          className="bg-tertiary-container hover:bg-tertiary-container"
        >
          {poLoading === 'review' ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="mr-1.5 h-3.5 w-3.5" />
          )}
          Run Review
        </Button>
      )}
      {hasReindexPrompt && (
        <Button
          variant="secondary"
          size="xs"
          onClick={onReindex}
          disabled={!desktopConnected || poLoading !== null}
        >
          {poLoading === 'reindex' ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          Refresh Knowledge
        </Button>
      )}
      <Button
        variant={showConfig ? 'primary' : 'secondary'}
        size="xs"
        onClick={onToggleConfig}
        className="ml-auto"
      >
        <Settings2 className="mr-1.5 h-3.5 w-3.5" />
        Configure
      </Button>
    </div>
  );
}
