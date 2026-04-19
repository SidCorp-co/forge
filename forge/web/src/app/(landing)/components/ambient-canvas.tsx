'use client';

import { useRef, useState, useEffect, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Points, PointMaterial } from '@react-three/drei';
import type { Points as PointsType } from 'three';

function ParticleField() {
  const ref = useRef<PointsType>(null);

  const positions = useMemo(() => {
    const count = 200;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 8;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 6;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 4;
    }
    return pos;
  }, []);

  useFrame((_, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += delta * 0.02;
    ref.current.rotation.x += delta * 0.01;
    ref.current.position.y = Math.sin(Date.now() * 0.0003) * 0.15;
  });

  return (
    <Points ref={ref} positions={positions} stride={3} frustumCulled={false}>
      <PointMaterial
        transparent
        color="#855300"
        size={0.025}
        sizeAttenuation
        depthWrite={false}
        opacity={0.15}
      />
    </Points>
  );
}

function checkWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    );
  } catch {
    return false;
  }
}

export function AmbientCanvas({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile || !checkWebGL()) return;
    setEnabled(true);
  }, []);

  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.1 }
    );
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, [enabled]);

  if (!enabled) {
    return (
      <div className={`pointer-events-none ${className ?? ''}`}>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(133,83,0,0.04)_0%,rgba(124,58,237,0.02)_50%,transparent_80%)]" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`pointer-events-none ${className ?? ''}`}>
      <Canvas
        frameloop={visible ? 'always' : 'never'}
        camera={{ position: [0, 0, 5], fov: 50 }}
        gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
        style={{ background: 'transparent' }}
      >
        <ParticleField />
      </Canvas>
    </div>
  );
}
