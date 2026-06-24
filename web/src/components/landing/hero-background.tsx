/**
 * Hero background — warm gray with a soft lighter radial glow.
 */
export function HeroBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 40%, rgba(255,255,255,0.15) 0%, transparent 70%)",
        }}
      />
    </div>
  );
}
