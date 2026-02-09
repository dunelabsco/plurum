"use client";

import { SmoothScrollProvider } from "./smooth-scroll-provider";
import { HeroSection } from "./hero-section";
import { PrimitivesSection } from "./primitives-section";
import { InstallSection } from "./install-section";
import { CtaSection } from "./cta-section";
import { TopNav } from "@/components/layout/top-nav";
import { SiteFooter } from "@/components/layout/site-footer";

export function LandingPage() {
  return (
    <SmoothScrollProvider>
      <div className="min-h-screen flex flex-col">
        <TopNav />
        <main className="flex-1">
          <HeroSection />
          <PrimitivesSection />
          <InstallSection />
          <CtaSection />
        </main>
        <SiteFooter />
      </div>
    </SmoothScrollProvider>
  );
}
