import { useState } from "react";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessageData, ToolCallData } from "@/lib/types";
import { coreMediaUrl } from "@/lib/api";
import { ImagePreview } from "./ui/image-preview";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ToolCallIndicator({ tc, index }: { tc: ToolCallData; index: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded-lg border border-gray-200 bg-gray-50 text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        {tc.isStreaming ? (
          <div className="h-3 w-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
        ) : tc.isError ? (
          <span className="text-red-500">✕</span>
        ) : (
          <span className="text-green-500">✓</span>
        )}
        <span className="font-medium text-gray-700">{tc.name}</span>
        {tc.durationMs && (
          <span className="ml-auto text-gray-400">{(tc.durationMs / 1000).toFixed(1)}s</span>
        )}
        <span className="text-gray-400">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && tc.input && (
        <pre className="max-h-40 overflow-auto border-t border-gray-200 px-3 py-2 text-gray-500">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessageData }) {
  const [copied, setCopied] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (msg.role === "system") {
    return (
      <div className="flex justify-center">
        <span className="rounded-lg bg-blue-50 px-3 py-1 text-xs text-blue-700">{msg.content}</span>
      </div>
    );
  }

  if (msg.role === "user") {
    return (
      <div className="flex justify-end group">
        <div className="max-w-[85%]">
          {/* Attachments */}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mb-1 flex gap-1 justify-end">
              {msg.attachments.map((a, i) => (
                <img
                  key={i}
                  src={coreMediaUrl(a.url)}
                  alt={a.name}
                  className="h-16 w-16 rounded-lg object-cover border border-gray-700 cursor-zoom-in"
                  onClick={() => setPreviewImage({ url: coreMediaUrl(a.url), name: a.name })}
                />
              ))}
            </div>
          )}
          {previewImage && (
            <ImagePreview src={previewImage.url} alt={previewImage.name} onClose={() => setPreviewImage(null)} />
          )}
          <div className="rounded-2xl bg-gray-900 px-4 py-2 text-base text-white">
            <p className="whitespace-pre-wrap">{msg.content}</p>
          </div>
          <p className="mt-0.5 text-right text-[10px] text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">
            {formatTime(msg.timestamp)}
          </p>
        </div>
      </div>
    );
  }

  // Assistant
  return (
    <div className="group">
      <div className="flex items-start gap-2">
        {/* AI avatar */}
        <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-[10px] font-bold text-white">
          AI
        </div>
        <div className="min-w-0 flex-1">
          {/* Thinking dots */}
          {msg.isStreaming && !msg.content && !msg.toolCalls?.length && (
            <div className="flex gap-1 px-2 py-2">
              <span className="h-2 w-2 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="h-2 w-2 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="h-2 w-2 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          )}

          {/* Tool calls */}
          {msg.toolCalls?.map((tc, i) => (
            <ToolCallIndicator key={`${tc.id}-${i}`} tc={tc} index={i} />
          ))}

          {/* Text content */}
          {msg.content && (
            <div className="prose prose-base max-w-none text-base text-gray-800">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
            </div>
          )}

          {/* Copy + timestamp */}
          <div className="mt-0.5 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-[10px] text-gray-400">{formatTime(msg.timestamp)}</p>
            {msg.content && (
              <button onClick={handleCopy} className="text-[10px] text-gray-400 hover:text-gray-600">
                {copied ? "Copied!" : "Copy"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface Props {
  messages: ChatMessageData[];
}

export function ChatMessageList({ messages }: Props) {
  const { containerRef, bottomRef, scrollToBottom, isNearBottom } = useScrollToBottom([messages]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const handleScroll = () => {
    setShowScrollBtn(!isNearBottom());
  };

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <svg className="mx-auto h-10 w-10 text-gray-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <p className="text-sm text-gray-400">Ask anything about this project</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="relative flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} />
      ))}
      <div ref={bottomRef} />
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-white border border-gray-200 shadow-md px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          ↓ Scroll to bottom
        </button>
      )}
    </div>
  );
}
