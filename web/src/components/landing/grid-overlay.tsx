"use client";

/**
 * Nothing-style dot grid.
 * Just dots. No lines, no markers. Uniform spacing.
 * z-40 so it sits ABOVE section backgrounds but below the nav (z-50).
 */
export function GridOverlay() {
  return (
    <div
      className="fixed inset-0 pointer-events-none z-40"
      aria-hidden="true"
      style={{
        backgroundImage:
          "radial-gradient(circle, rgba(0,0,0,0.1) 1.2px, transparent 1.2px)",
        backgroundSize: "110px 110px",
        backgroundPosition: "55px 55px",
      }}
    />
  );
}
