"use client";

import { motion } from "motion/react";

export function HeroBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Grid pattern */}
      <div className="absolute inset-0 grid-pattern opacity-40" />

      {/* Animated glow orb */}
      <motion.div
        className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[600px] glow-orb"
        animate={{
          scale: [1, 1.08, 1],
          opacity: [0.6, 0.8, 0.6],
        }}
        transition={{
          duration: 8,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Secondary subtle orb */}
      <motion.div
        className="absolute top-[10%] right-[-10%] w-[400px] h-[400px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, oklch(0.50 0.15 260 / 0.06) 0%, transparent 70%)",
        }}
        animate={{
          scale: [1, 1.15, 1],
          opacity: [0.4, 0.6, 0.4],
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 2,
        }}
      />

      {/* Bottom fade to background */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
    </div>
  );
}
