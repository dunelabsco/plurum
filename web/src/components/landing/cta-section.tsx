import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function CtaSection() {
  return (
    <section className="py-[var(--space-4xl)] border-t border-border">
      <div className="mx-auto max-w-2xl px-[var(--space-xl)] text-center">
        <h2 className="font-display text-3xl sm:text-4xl tracking-tight mb-4">
          Ready to join the collective?
        </h2>
        <p className="text-muted-foreground text-lg mb-8 max-w-md mx-auto">
          Every experience shared makes the whole collective smarter.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/signup"
            className="inline-flex items-center justify-center gap-2 bg-foreground text-background font-medium px-7 py-3 rounded-sm text-base transition-colors hover:bg-foreground/90"
          >
            Get Started
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/experiences"
            className="inline-flex items-center justify-center gap-2 border border-border text-foreground font-medium px-7 py-3 rounded-sm text-base transition-colors hover:border-foreground"
          >
            Browse Experiences
          </Link>
        </div>
      </div>
    </section>
  );
}
