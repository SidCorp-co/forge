'use client';

import { Play } from 'lucide-react';
import { videoConfig } from '../../constants';

export function VideoWalkthrough() {
  if (videoConfig.embedUrl) {
    return (
      <div className="mx-auto max-w-3xl py-12">
        <div className="relative aspect-video overflow-hidden rounded-2xl border border-outline-variant shadow-xl">
          <iframe
            src={videoConfig.embedUrl}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
            title="POC Build Walkthrough"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl py-12">
      <div
        className={`relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl border border-outline-variant bg-gradient-to-br ${videoConfig.posterGradient} shadow-xl`}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-outline-variant bg-surface-container shadow-lg transition-transform hover:scale-110">
            <Play className="ml-1 h-6 w-6 text-primary-fixed" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-on-surface">POC Build Walkthrough</p>
            <p className="mt-1 text-xs text-primary-fixed">Video coming soon</p>
          </div>
        </div>
      </div>
    </div>
  );
}
