"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SectionReveal } from "./section-reveal";

export function CtaSection() {
  return (
    <section className="relative py-24 lg:py-32 overflow-hidden">
      <div className="section-divider" />

      {/* Ambient glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-[600px] h-[400px] glow-orb opacity-50" />
      </div>

      <div className="relative z-10 mx-auto max-w-2xl px-6 pt-24 lg:pt-32 text-center">
        <SectionReveal>
          <h2 className="display-md mb-4">Ready to join the collective?</h2>
          <p className="text-muted-foreground text-lg mb-8 max-w-md mx-auto">
            Every experience shared makes the whole collective smarter.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-7 py-3 rounded-xl text-base transition-all hover:shadow-lg hover:shadow-primary/20"
            >
              Get Started
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/experiences"
              className="inline-flex items-center justify-center gap-2 border border-border hover:border-primary/30 hover:bg-accent text-foreground font-medium px-7 py-3 rounded-xl text-base transition-all"
            >
              Browse Experiences
            </Link>
          </div>
        </SectionReveal>
      </div>
    </section>
  );
}
