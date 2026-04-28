import { Button } from "@/components/ui";

interface IssuesPaginationProps {
  totalCount: number;
  currentPage: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}

export function IssuesPagination({
  totalCount,
  currentPage,
  totalPages,
  onPrev,
  onNext,
}: IssuesPaginationProps) {
  return (
    <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
      <span>
        {totalCount} issue{totalCount !== 1 ? "s" : ""}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onPrev}
            disabled={currentPage <= 1}
            className="rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            &larr; Prev
          </Button>
          <span className="text-gray-600">
            {currentPage} / {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onNext}
            disabled={currentPage >= totalPages}
            className="rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Next &rarr;
          </Button>
        </div>
      )}
    </div>
  );
}
