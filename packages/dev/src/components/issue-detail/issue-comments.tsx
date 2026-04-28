import { useState, useEffect } from "react";
import type { Comment } from "@/lib/types";
import { getComments, createComment, updateComment, deleteComment } from "@/lib/api";
import { Markdown } from "../ui/markdown";
import { useMountedRef } from "@/hooks/use-mounted-ref";

interface Props {
  issueDocumentId: string;
  initialComments: Comment[];
}

function CommentItem({
  comment,
  currentUser,
  depth,
  onReply,
  onEdit,
  onDelete,
  replyingTo,
  replyBody,
  onReplyBodyChange,
  onSubmitReply,
  onCancelReply,
  submitting,
}: {
  comment: Comment;
  currentUser: string;
  depth: number;
  onReply: (documentId: string) => void;
  onEdit: (documentId: string, body: string) => void;
  onDelete: (documentId: string) => void;
  replyingTo: string | null;
  replyBody: string;
  onReplyBodyChange: (body: string) => void;
  onSubmitReply: () => void;
  onCancelReply: () => void;
  submitting: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const isOwner = comment.author === currentUser;

  const handleSaveEdit = () => {
    if (editBody.trim() && editBody !== comment.body) {
      onEdit(comment.documentId, editBody);
    }
    setEditing(false);
  };

  return (
    <div className={depth > 0 ? "ml-6 border-l-2 border-gray-100 pl-3" : ""}>
      <div className={`group rounded-lg border p-2.5 ${comment.isAI ? "border-blue-100 bg-blue-50" : "bg-gray-50"}`}>
        <div className="mb-0.5 flex items-center justify-between">
          <p className="text-[10px] font-medium text-gray-400">
            {comment.author}{comment.isAI ? " (AI)" : ""} · {new Date(comment.createdAt).toLocaleString()}
          </p>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onReply(comment.documentId)}
              className="rounded p-1 text-[10px] text-gray-400 hover:bg-gray-200 hover:text-gray-600"
              title="Reply"
            >
              Reply
            </button>
            {isOwner && !comment.isAI && (
              <>
                <button
                  type="button"
                  onClick={() => { setEditBody(comment.body); setEditing(true); }}
                  className="rounded p-1 text-[10px] text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                  title="Edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(comment.documentId)}
                  className="rounded p-1 text-[10px] text-gray-400 hover:bg-red-100 hover:text-red-600"
                  title="Delete"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>

        {editing ? (
          <div>
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={2}
              className="w-full rounded border px-2 py-1 text-sm focus:border-gray-400 focus:outline-none"
            />
            <div className="mt-1 flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={!editBody.trim()}
                className="rounded bg-black px-2 py-0.5 text-xs text-white hover:bg-gray-800 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <Markdown>{comment.body}</Markdown>
        )}
      </div>

      {/* Inline reply form */}
      {replyingTo === comment.documentId && (
        <div className="mt-2 ml-2">
          <textarea
            value={replyBody}
            onChange={(e) => onReplyBodyChange(e.target.value)}
            placeholder={`Reply to ${comment.author}...`}
            rows={2}
            className="w-full rounded border px-2 py-1 text-sm focus:border-gray-400 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmitReply();
              if (e.key === "Escape") onCancelReply();
            }}
          />
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onCancelReply} className="rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100">Cancel</button>
            <button type="button" onClick={onSubmitReply} disabled={!replyBody.trim() || submitting} className="rounded bg-black px-2 py-0.5 text-xs text-white hover:bg-gray-800 disabled:opacity-50">Reply</button>
          </div>
        </div>
      )}

      {/* Nested replies */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="mt-2 space-y-2">
          {[...comment.replies]
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .map((reply) => (
              <CommentItem
                key={reply.id}
                comment={reply}
                currentUser={currentUser}
                depth={depth + 1}
                onReply={onReply}
                onEdit={onEdit}
                onDelete={onDelete}
                replyingTo={replyingTo}
                replyBody={replyBody}
                onReplyBodyChange={onReplyBodyChange}
                onSubmitReply={onSubmitReply}
                onCancelReply={onCancelReply}
                submitting={submitting}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export function IssueComments({ issueDocumentId, initialComments }: Props) {
  const [commentBody, setCommentBody] = useState("");
  const [comments, setComments] = useState(initialComments);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const mountedRef = useMountedRef();
  const username = "";

  const refreshComments = () => {
    getComments(issueDocumentId).then((data) => {
      if (mountedRef.current) setComments(data);
    }).catch(() => {});
  };

  useEffect(() => {
    refreshComments();
  }, [issueDocumentId]);

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setSubmittingComment(true);
    try {
      await createComment({ body: commentBody, issue: issueDocumentId });
      if (mountedRef.current) {
        setCommentBody("");
        refreshComments();
      }
    } catch {} finally {
      if (mountedRef.current) setSubmittingComment(false);
    }
  }

  async function handleEdit(documentId: string, body: string) {
    try {
      await updateComment(documentId, { body });
      refreshComments();
    } catch {}
  }

  async function handleDelete(documentId: string) {
    try {
      await deleteComment(documentId);
      refreshComments();
    } catch {}
  }

  async function handleSubmitReply() {
    if (!replyBody.trim() || !replyingTo) return;
    setSubmittingComment(true);
    try {
      await createComment({ body: replyBody, issue: issueDocumentId, parent: replyingTo });
      if (mountedRef.current) {
        setReplyBody("");
        setReplyingTo(null);
        refreshComments();
      }
    } catch {} finally {
      if (mountedRef.current) setSubmittingComment(false);
    }
  }

  // Build tree: only show root-level comments
  const rootComments = comments.filter((c) => !c.parent);

  return (
    <div className="px-6 py-4">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">Comments</h3>
      {rootComments.length === 0 ? (
        <p className="text-xs text-gray-400 mb-3">No comments yet.</p>
      ) : (
        <div className="mb-3 space-y-2">
          {[...rootComments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              currentUser={username}
              depth={0}
              onReply={(id) => { setReplyingTo(id); setReplyBody(""); }}
              onEdit={handleEdit}
              onDelete={handleDelete}
              replyingTo={replyingTo}
              replyBody={replyBody}
              onReplyBodyChange={setReplyBody}
              onSubmitReply={handleSubmitReply}
              onCancelReply={() => { setReplyingTo(null); setReplyBody(""); }}
              submitting={submittingComment}
            />
          ))}
        </div>
      )}
      <form onSubmit={handleAddComment} className="flex gap-2">
        <input
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment... (use @ to mention)"
          className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-gray-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!commentBody.trim() || submittingComment}
          className="rounded-lg bg-black px-3 py-1.5 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
        >
          Comment
        </button>
      </form>
    </div>
  );
}
