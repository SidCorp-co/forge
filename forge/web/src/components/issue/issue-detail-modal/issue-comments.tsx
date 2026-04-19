'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { Markdown } from '@/components/ui/markdown';
import { MentionInput } from '@/components/ui/mention-input';
import { relativeTime } from '@/lib/utils/relative-time';
import { Pencil, Trash2, Reply, X, Check, FileText } from 'lucide-react';
import { FileUpload, type UploadedFile } from '@/components/ui/file-upload';
import { strapiMediaUrl } from '@/lib/api/client';
import { ImagePreview } from '@/components/ui/image-preview';
import { commentApi } from '@/features/comment/api/comment-api';
import type { Comment } from '@/features/comment/types';

interface IssueCommentsProps {
  comments: Comment[];
  currentUser: string;
  onAddComment: (body: string, parentOrAttachments?: string | number[]) => void;
  onEditComment: (documentId: string, body: string) => void;
  onDeleteComment: (documentId: string) => void;
}

function CommentAttachments({ attachments }: { attachments: Comment['attachments'] }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  if (!attachments || attachments.length === 0) return null;
  const imageGallery = attachments.filter((a) => /^image\//.test(a.mime)).map((a) => ({ url: strapiMediaUrl(a.url), name: a.name }));
  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {attachments.map((a) => {
          const isImage = /^image\//.test(a.mime);
          const isVideo = /^video\//.test(a.mime);
          const fullUrl = strapiMediaUrl(a.url);
          return isImage ? (
            <button
              key={a.id}
              type="button"
              onClick={() => setPreviewIndex(imageGallery.findIndex((img) => img.url === fullUrl))}
              className="flex items-center gap-1.5 rounded border bg-surface-container-low px-2.5 py-2 text-xs text-on-surface-variant hover:bg-surface-container-high cursor-zoom-in"
            >
              <img src={fullUrl} alt={a.name} className="h-8 w-8 rounded object-cover" />
              <span className="max-w-[100px] truncate">{a.name}</span>
            </button>
          ) : isVideo ? (
            <div key={a.id} className="overflow-hidden rounded border bg-surface-container-low">
              <video src={fullUrl} controls preload="metadata" className="max-h-36 max-w-[280px] rounded" />
              <p className="truncate px-2 py-1 text-xs text-on-surface-variant">{a.name}</p>
            </div>
          ) : (
            <a
              key={a.id}
              href={fullUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 rounded border bg-surface-container-low px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high"
            >
              <FileText className="h-3.5 w-3.5 text-outline" />
              <span className="max-w-[100px] truncate">{a.name}</span>
            </a>
          );
        })}
      </div>
      {previewIndex !== null && (
        <ImagePreview images={imageGallery} initialIndex={previewIndex} onClose={() => setPreviewIndex(null)} />
      )}
    </>
  );
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
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const isOwner = comment.author === currentUser;
  const isReplying = replyingTo === comment.documentId;

  const handleSaveEdit = () => {
    if (editBody.trim() && editBody !== comment.body) {
      onEdit(comment.documentId, editBody);
    }
    setEditing(false);
  };

  return (
    <div className={cn(depth > 0 && 'ml-6 border-l-2 border-outline-variant/20 pl-3')}>
      <div className="group rounded-lg border border-info/20 bg-info-surface/20 p-2.5">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[10px] font-medium text-outline">
            {comment.author}{comment.isAI ? ' (AI)' : ''} · {relativeTime(comment.createdAt)}
          </p>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onReply(comment.documentId)}
              className="rounded p-1 text-outline hover:bg-surface-variant hover:text-on-surface-variant"
              title="Reply"
            >
              <Reply className="h-3 w-3" />
            </button>
            {isOwner && !comment.isAI && (
              <>
                <button
                  type="button"
                  onClick={() => { setEditBody(comment.body); setEditing(true); }}
                  className="rounded p-1 text-outline hover:bg-surface-variant hover:text-on-surface-variant"
                  title="Edit"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(comment.documentId)}
                  className="rounded p-1 text-outline hover:bg-danger-surface hover:text-danger"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        </div>

        {editing ? (
          <div>
            <MentionInput
              value={editBody}
              onChange={setEditBody}
              rows={2}
            />
            <div className="mt-1 flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded p-1 text-outline hover:text-on-surface-variant"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={!editBody.trim()}
                className="rounded p-1 text-success hover:text-success disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <Markdown className="text-sm">{comment.body}</Markdown>
        )}
        <CommentAttachments attachments={comment.attachments} />
      </div>

      {/* Inline reply form */}
      {isReplying && (
        <div className="mt-2 ml-2">
          <MentionInput
            value={replyBody}
            onChange={onReplyBodyChange}
            placeholder={`Reply to ${comment.author}...`}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmitReply();
              if (e.key === 'Escape') onCancelReply();
            }}
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelReply}
              className="rounded px-2 py-1 text-xs text-primary-fixed hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmitReply}
              disabled={!replyBody.trim()}
              className="rounded bg-info px-2 py-1 text-xs text-white hover:bg-info-dim disabled:opacity-50"
            >
              Reply
            </button>
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
              />
            ))}
        </div>
      )}
    </div>
  );
}

export function IssueComments({ comments, currentUser, onAddComment, onEditComment, onDeleteComment }: IssueCommentsProps) {
  const [commentBody, setCommentBody] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);

  // Build tree: only show root-level comments (no parent), replies are nested
  const rootComments = comments.filter((c) => !c.parent);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentBody.trim()) return;
    const attachmentIds = attachments.length > 0 ? attachments.map((a) => a.id) : undefined;
    onAddComment(commentBody, attachmentIds);
    setCommentBody('');
    setAttachments([]);
  };

  const handleSubmitReply = () => {
    if (!replyBody.trim() || !replyingTo) return;
    onAddComment(replyBody, replyingTo);
    setReplyBody('');
    setReplyingTo(null);
  };

  return (
    <div className="px-4 py-4 sm:px-6">
      <h3 className="mb-2 text-sm font-semibold">Comments</h3>
      {rootComments.length === 0 ? (
        <p className="text-xs text-outline">No comments yet.</p>
      ) : (
        <div className="mb-3 space-y-2">
          {[...rootComments]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                currentUser={currentUser}
                depth={0}
                onReply={(id) => { setReplyingTo(id); setReplyBody(''); }}
                onEdit={onEditComment}
                onDelete={onDeleteComment}
                replyingTo={replyingTo}
                replyBody={replyBody}
                onReplyBodyChange={setReplyBody}
                onSubmitReply={handleSubmitReply}
                onCancelReply={() => { setReplyingTo(null); setReplyBody(''); }}
              />
            ))}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <MentionInput
          value={commentBody}
          onChange={setCommentBody}
          placeholder="Add a comment... (use @ to mention)"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (commentBody.trim()) {
                const attachmentIds = attachments.length > 0 ? attachments.map((a) => a.id) : undefined;
                onAddComment(commentBody, attachmentIds);
                setCommentBody('');
                setAttachments([]);
              }
            }
          }}
        />
        <FileUpload
          value={attachments}
          onChange={setAttachments}
          uploadFn={commentApi.uploadFile}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-outline">Ctrl+Enter to submit</span>
          <button
            type="submit"
            disabled={!commentBody.trim()}
            className="rounded-lg bg-info px-3 py-1.5 text-xs font-medium text-white hover:bg-info-dim disabled:opacity-50"
          >
            Comment
          </button>
        </div>
      </form>
    </div>
  );
}
