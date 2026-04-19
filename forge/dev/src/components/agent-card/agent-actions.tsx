import { Button } from "@/components/ui";

interface AgentActionsProps {
  hasReviewPrompt: boolean;
  hasReindexPrompt: boolean;
  enabled: boolean;
  poLoading: "review" | "reindex" | null;
  showConfig: boolean;
  onPoAction: (action: "review" | "reindex") => void;
  onToggleConfig: () => void;
}

export function AgentActions({
  hasReviewPrompt,
  hasReindexPrompt,
  enabled,
  poLoading,
  showConfig,
  onPoAction,
  onToggleConfig,
}: AgentActionsProps) {
  return (
    <div className="flex items-center gap-2 border-t border-gray-100 px-5 py-3">
      {hasReviewPrompt && (
        <Button
          size="sm"
          onClick={() => onPoAction("review")}
          disabled={!enabled || poLoading !== null}
          className="bg-purple-600 hover:bg-purple-700"
        >
          {poLoading === "review" ? "Starting..." : "Run Review"}
        </Button>
      )}
      {hasReindexPrompt && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPoAction("reindex")}
          disabled={poLoading !== null}
        >
          {poLoading === "reindex" ? "Starting..." : "Refresh Knowledge"}
        </Button>
      )}
      <Button
        variant={showConfig ? "primary" : "secondary"}
        size="sm"
        onClick={onToggleConfig}
        className="ml-auto"
      >
        Configure
      </Button>
    </div>
  );
}
