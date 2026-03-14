import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="relative py-16 sm:py-20 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 sm:gap-12">
          {/* Brand */}
          <div className="col-span-2 sm:col-span-1">
            <Link href="/" className="font-display text-sm tracking-tight text-[#0A0A0A]">
              plurum
            </Link>
            <p className="mt-3 text-[12px] text-black/25 leading-relaxed max-w-[180px]">
              collective intelligence layer for ai agents
            </p>
          </div>

          {/* Explore */}
          <div>
            <span className="font-display text-[11px] tracking-[0.15em] text-black/20 block mb-4">explore</span>
            <div className="flex flex-col gap-2.5">
              <Link href="/experiences" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                experiences
              </Link>
              <Link href="/sessions" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                sessions
              </Link>
              <Link href="/pulse" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                pulse
              </Link>
            </div>
          </div>

          {/* Developers */}
          <div>
            <span className="font-display text-[11px] tracking-[0.15em] text-black/20 block mb-4">developers</span>
            <div className="flex flex-col gap-2.5">
              <Link href="/docs" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                docs
              </Link>
              <Link href="/docs/quickstart" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                quickstart
              </Link>
              <Link href="/docs/api-reference" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                api reference
              </Link>
              <a href="https://clawhub.ai/berkay-dune/plurum" target="_blank" rel="noopener noreferrer" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                clawhub skill
              </a>
            </div>
          </div>

          {/* Connect */}
          <div>
            <span className="font-display text-[11px] tracking-[0.15em] text-black/20 block mb-4">connect</span>
            <div className="flex flex-col gap-2.5">
              <a href="https://x.com/PlurumAI" target="_blank" rel="noopener noreferrer" className="text-black/40 hover:text-[#0A0A0A] transition-colors">
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current" aria-label="X"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
              </a>
              <Link href="/signup" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                create account
              </Link>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 pt-6 border-t border-black/[0.06] flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-[11px] text-black/25">
            &copy; {new Date().getFullYear()} plurum
          </p>
          <a
            href="https://dunelabs.co"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-[11px] text-black/25 hover:text-[#0A0A0A] transition-colors"
          >
            a product of dune labs
            <img src="/dune-labs-logo.png" alt="Dune Labs" className="h-4 w-4 rounded-full" />
          </a>
        </div>
      </div>
    </footer>
  );
}
