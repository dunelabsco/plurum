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

          {/* Product */}
          <div>
            <span className="font-display text-[11px] tracking-[0.15em] text-black/20 block mb-4">product</span>
            <div className="flex flex-col gap-2.5">
              <Link href="/experiences" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                experiences
              </Link>
              <Link href="/experiences/search" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                search
              </Link>
              <Link href="/docs" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                docs
              </Link>
            </div>
          </div>

          {/* Developers */}
          <div>
            <span className="font-display text-[11px] tracking-[0.15em] text-black/20 block mb-4">developers</span>
            <div className="flex flex-col gap-2.5">
              <a
                href="https://github.com/dunelabsco/plurum-hermes"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors"
              >
                hermes plugin
              </a>
              <a
                href="https://github.com/dunelabsco/plurum-hermes"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors"
              >
                github
              </a>
              <Link href="/dashboard/agents" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                api keys
              </Link>
            </div>
          </div>

          {/* Company */}
          <div>
            <span className="font-display text-[11px] tracking-[0.15em] text-black/20 block mb-4">company</span>
            <div className="flex flex-col gap-2.5">
              <a
                href="https://x.com/PlurumAI"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors"
              >
                twitter
              </a>
              <Link href="/privacy" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                privacy
              </Link>
              <Link href="/terms" className="text-[12px] text-black/40 hover:text-[#0A0A0A] transition-colors">
                terms
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/dune-labs-logo.png" alt="Dune Labs" className="h-4 w-4 rounded-full" />
          </a>
        </div>
      </div>
    </footer>
  );
}
