"use client";

import { useEffect, useRef } from "react";

const CHARS = " .·:;+=xX$&#@";

// Simple 2D noise (value noise with smoothing)
function hash(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return (h ^ (h >> 16)) / 2147483648;
}

function smoothNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smoothstep
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash(ix, iy);
  const n10 = hash(ix + 1, iy);
  const n01 = hash(ix, iy + 1);
  const n11 = hash(ix + 1, iy + 1);

  const nx0 = n00 + sx * (n10 - n00);
  const nx1 = n01 + sx * (n11 - n01);

  return nx0 + sy * (nx1 - nx0);
}

function fbm(x: number, y: number, octaves: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * smoothNoise(x * frequency, y * frequency);
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value;
}

export function AsciiField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    const charW = 10;
    const charH = 16;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = document.documentElement.scrollHeight;
    };

    let time = 0;

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;
      const cols = Math.ceil(w / charW);
      const rows = Math.ceil(h / charH);

      ctx.clearRect(0, 0, w, h);
      ctx.font = `${charH - 2}px monospace`;
      ctx.textBaseline = "top";

      time += 0.003;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          // Sample noise at this grid position
          const nx = col * 0.04;
          const ny = row * 0.04;

          const n = fbm(nx + time * 2, ny + Math.sin(time + col * 0.01) * 0.5, 3);

          // Only render characters where noise exceeds threshold — creates organic clusters
          if (n > 0.42) {
            const intensity = (n - 0.42) / 0.58; // normalize 0-1
            const charIndex = Math.floor(intensity * (CHARS.length - 1));
            const char = CHARS[Math.min(charIndex, CHARS.length - 1)];

            const alpha = intensity * 0.12;
            ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
            ctx.fillText(char, col * charW, row * charH);
          }
        }
      }

      animationId = requestAnimationFrame(render);
    };

    resize();
    animationId = requestAnimationFrame(render);

    const handleResize = () => resize();
    window.addEventListener("resize", handleResize);

    // Update canvas height when page content changes
    const resizeObserver = new ResizeObserver(() => {
      canvas.height = document.documentElement.scrollHeight;
    });
    resizeObserver.observe(document.body);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none z-0"
      aria-hidden="true"
    />
  );
}
