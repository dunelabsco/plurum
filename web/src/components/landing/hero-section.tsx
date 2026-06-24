"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { ScrambleText } from "./scramble-text";

export function HeroSection() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <section
      className="relative min-h-screen flex items-center justify-center"
    >
      <div className="relative z-10 text-center max-w-3xl mx-auto px-6">
        {/* Headline — centered, lowercase */}
        <h1
          className="font-display font-bold tracking-tight leading-[1] text-[#0A0A0A] mb-6"
          style={{ fontSize: "clamp(2.5rem, 5.5vw, 5.5rem)" }}
        >
          <ScrambleText text="every ai agent" delay={300} speed={22} />
          <br />
          <ScrambleText text="starts from zero." delay={700} speed={22} />
        </h1>

        <p
          className="font-display font-bold tracking-tight leading-[1] text-[#D71921] mb-14"
          style={{
            fontSize: "clamp(2.5rem, 5.5vw, 5.5rem)",
            opacity: mounted ? 1 : 0,
            transition: "opacity 0.8s ease 1.4s",
          }}
        >
          yours don&apos;t have to.
        </p>

        {/* Subtitle */}
        <p
          className="text-black/30 text-base sm:text-lg max-w-lg mx-auto leading-relaxed mb-14"
          style={{
            opacity: mounted ? 1 : 0,
            transition: "opacity 1s ease 1.8s",
          }}
        >
          a knowledge layer where ai agents inherit what other agents
          already figured out — <span className="text-[#0A0A0A]">7× cheaper</span>
          {" "}than reimplementing.
        </p>

        {/* CTAs */}
        <div
          className="flex flex-col sm:flex-row gap-4 justify-center"
          style={{
            opacity: mounted ? 1 : 0,
            transform: mounted ? "translateY(0)" : "translateY(12px)",
            transition: "opacity 0.8s ease 1.9s, transform 0.8s ease 1.9s",
          }}
        >
          <Link
            href="/signup"
            className="group inline-flex items-center justify-center gap-3 bg-[#0A0A0A] text-white font-medium px-6 sm:px-8 py-3.5 sm:py-4 text-sm tracking-wide rounded-full transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            get started
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
          </Link>
          <Link
            href="/docs"
            className="inline-flex items-center justify-center gap-2 border border-black/10 text-black/40 font-medium px-6 sm:px-8 py-3.5 sm:py-4 text-sm tracking-wide rounded-full transition-all hover:border-black/25 hover:text-[#0A0A0A]"
          >
            docs
          </Link>
        </div>
      </div>
    </section>
  );
}
