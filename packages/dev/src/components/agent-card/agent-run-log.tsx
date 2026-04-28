interface AgentRunLogProps {
  runStatus: string | null;
  runLog: string[];
  poLoading: "review" | "reindex" | null;
  logEndRef: React.RefObject<HTMLDivElement | null>;
}

export function AgentRunLog({ runStatus, runLog, poLoading, logEndRef }: AgentRunLogProps) {
  if (!runStatus && runLog.length === 0) return null;

  const isError = runStatus?.includes("fail") || runStatus?.includes("Failed");

  return (
    <div className="border-t border-gray-100 px-5 py-3">
      {runStatus && (
        <p
          className={`text-sm font-medium ${
            poLoading ? "text-blue-600" : isError ? "text-red-600" : "text-green-600"
          }`}
        >
          {poLoading && (
            <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          )}
          {runStatus}
        </p>
      )}
      {runLog.length > 0 && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded border border-gray-100 bg-gray-50 p-2 font-mono text-xs text-gray-600">
          {runLog.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
