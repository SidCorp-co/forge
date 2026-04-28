'use client';

import { useState, useEffect, useCallback } from 'react';

interface ImagePreviewImage {
  url: string;
  name: string;
}

interface ImagePreviewProps {
  /** Single image (backward-compatible) */
  src?: string;
  alt?: string;
  /** Gallery mode: array of images + starting index */
  images?: ImagePreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}

export function ImagePreview({ src, alt, images, initialIndex = 0, onClose }: ImagePreviewProps) {
  // Build gallery from either prop style
  const gallery: ImagePreviewImage[] = images?.length
    ? images
    : src
      ? [{ url: src, name: alt || '' }]
      : [];

  const [index, setIndex] = useState(initialIndex);
  const hasMultiple = gallery.length > 1;
  const current = gallery[index] || gallery[0];

  const goNext = useCallback(() => {
    if (hasMultiple) setIndex((i) => (i + 1) % gallery.length);
  }, [hasMultiple, gallery.length]);

  const goPrev = useCallback(() => {
    if (hasMultiple) setIndex((i) => (i - 1 + gallery.length) % gallery.length);
  }, [hasMultiple, gallery.length]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goNext(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPrev(); }
    },
    [onClose, goNext, goPrev]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-on-primary/80 p-4 cursor-zoom-out"
      onClick={onClose}
    >
      {/* Previous button */}
      {hasMultiple && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); goPrev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-on-surface/20 p-2 text-on-surface backdrop-blur hover:bg-on-surface/40 transition-colors"
          aria-label="Previous image"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Image */}
      <img
        src={current.url}
        alt={current.name}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />

      {/* Next button */}
      {hasMultiple && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-on-surface/20 p-2 text-on-surface backdrop-blur hover:bg-on-surface/40 transition-colors"
          aria-label="Next image"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* Counter + name */}
      {hasMultiple && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full bg-on-primary/60 px-4 py-1.5 text-sm text-on-surface backdrop-blur">
          <span>{index + 1} / {gallery.length}</span>
          <span className="text-on-surface/60">—</span>
          <span className="max-w-[200px] truncate text-on-surface/80">{current.name}</span>
        </div>
      )}
    </div>
  );
}
