'use client';

import { useState, useEffect } from 'react';

export interface SpriteFrame {
  url: string;
  name: string;
}

interface PokemonSpriteProps {
  /** Session status determines animation behavior */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'idle';
  /** First form sprite URL (used for queued/completed/idle) */
  sprite: string;
  /** Full evolution chain with all poses (cycled when running) */
  chain: SpriteFrame[];
  /** Pokémon name for alt/title */
  name: string;
  /** Skill name for tooltip */
  skill: string;
  className?: string;
}

/** Cycle interval in ms — front/back alternate within each evolution stage */
const FRAME_INTERVAL = 3000;

export function PokemonSprite({ status, sprite, chain, name, skill, className = 'h-10 w-10' }: PokemonSpriteProps) {
  const [frameIndex, setFrameIndex] = useState(0);

  // Cycle through all frames (front/back for each evolution) when running
  useEffect(() => {
    if (status !== 'running' || chain.length <= 1) {
      setFrameIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setFrameIndex((i) => (i + 1) % chain.length);
    }, FRAME_INTERVAL);
    return () => clearInterval(interval);
  }, [status, chain.length]);

  const currentFrame = status === 'running' ? chain[frameIndex] : null;
  const currentSprite = currentFrame?.url ?? sprite;
  const currentName = currentFrame?.name ?? name;
  const isFainted = status === 'failed';

  return (
    <div
      className="flex items-center justify-center shrink-0"
      title={`${currentName} — ${skill}`}
    >
      <img
        src={currentSprite}
        alt={currentName}
        className={`${className} object-contain image-rendering-pixelated transition-opacity duration-300 ${
          isFainted ? 'grayscale opacity-40 -rotate-90' : ''
        }`}
      />
    </div>
  );
}
