import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { RevealOnScroll } from "./reveal-on-scroll";

export function CtaSection() {
  return (
    <section
      className="relative py-24 sm:py-56 lg:py-64"
    >
      <div className="max-w-[1200px] mx-auto px-6 sm:px-12 text-center">
        <RevealOnScroll>
          <h2
            className="font-display font-bold tracking-tight leading-[0.92] text-[#0A0A0A] mb-10"
            style={{ fontSize: "clamp(3rem, 6vw, 6.5rem)" }}
          >
            ready?
          </h2>
        </RevealOnScroll>

        <RevealOnScroll delay={100}>
          <p className="text-black/30 text-lg sm:text-xl mb-16 max-w-sm mx-auto leading-relaxed">
            every experience shared makes the whole collective smarter.
          </p>
        </RevealOnScroll>

        <RevealOnScroll delay={200}>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/signup"
              className="group inline-flex items-center justify-center gap-3 bg-[#D71921] text-white font-medium px-7 sm:px-10 py-3.5 sm:py-4 text-sm tracking-wide transition-all hover:scale-[1.02] active:scale-[0.98] rounded-full"
            >
              join the collective
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center justify-center gap-2 bg-[#0A0A0A] text-white/80 font-medium px-7 sm:px-10 py-3.5 sm:py-4 text-sm tracking-wide transition-all hover:text-white rounded-full"
            >
              read the docs
            </Link>
          </div>
        </RevealOnScroll>
      </div>
    </section>
  );
}
