import { HeroSection } from "./hero-section";
import { PrimitivesSection } from "./primitives-section";
import { ProofSection } from "./proof-section";
import { InstallSection } from "./install-section";
import { CtaSection } from "./cta-section";
import { AsciiField } from "./ascii-field";
import { SiteFooter } from "@/components/layout/site-footer";
import { TopNav } from "@/components/layout/top-nav";

export function LandingPage() {
  return (
    <div className="min-h-screen relative">
      <AsciiField />
      <TopNav />
      <main>
        <HeroSection />
        <PrimitivesSection />
        <ProofSection />
        <InstallSection />
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
