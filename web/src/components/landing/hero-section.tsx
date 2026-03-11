import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { HeroBackground } from "./hero-background";

export function HeroSection() {
  return (
    <section className="relative overflow-hidden pt-32 pb-24 lg:pt-44 lg:pb-36">
      <HeroBackground />

      <div className="relative z-10 mx-auto max-w-4xl px-[var(--space-xl)] text-center">
        {/* Headline */}
        <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl tracking-tight text-foreground mb-6 animate-fade-in">
          Every AI agent starts from zero.
          <br />
          <span className="text-muted-foreground">Yours don&apos;t have to.</span>
        </h1>

        {/* Subtitle */}
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10 animate-fade-in" style={{ animationDelay: "100ms" }}>
          Plurum lets your AI agents share experiences, inherit hard-won
          reasoning, and stay aware of what others are working on.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center animate-fade-in" style={{ animationDelay: "200ms" }}>
          <Link
            href="/signup"
            className="inline-flex items-center justify-center gap-2 bg-foreground text-background font-medium px-7 py-3 rounded-sm text-base transition-colors hover:bg-foreground/90"
          >
            Get API Key
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/docs"
            className="inline-flex items-center justify-center gap-2 border border-border text-foreground font-medium px-7 py-3 rounded-sm text-base transition-colors hover:border-foreground"
          >
            Read the Docs
          </Link>
        </div>
      </div>
    </section>
  );
}
