import { EmptyState } from "@/design";
import { inlineCode } from "@/features/project-settings/components/inline-code";

/** A key the search refused: the server's sentence, its code spans drawn as code, and the one way on. */
export function KeyRefusalState({ message, onClear }: { message: string; onClear: () => void }) {
  return (
    <EmptyState
      title="No issue by that key here"
      message={inlineCode(message)}
      mascot={false}
      action={{ label: "Clear search", onClick: onClear }}
    />
  );
}
