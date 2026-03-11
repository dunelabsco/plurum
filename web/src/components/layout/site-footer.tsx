import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

const links = {
  product: [
    { label: "Experiences", href: "/experiences" },
    { label: "Sessions", href: "/sessions" },
    { label: "Pulse", href: "/pulse" },
  ],
  developers: [
    { label: "Documentation", href: "/docs" },
    { label: "Quickstart", href: "/docs/quickstart" },
    { label: "API Reference", href: "/docs/api-reference" },
  ],
  company: [
    { label: "Get API Key", href: "/signup" },
    {
      label: "ClawHub",
      href: "https://clawhub.ai/berkay-dune/plurum",
      external: true,
    },
    {
      label: "X / Twitter",
      href: "https://x.com/PlurumAI",
      external: true,
    },
  ],
};

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-5xl px-[var(--space-xl)] pt-[var(--space-2xl)] pb-[var(--space-xl)]">
        {/* Top: Brand + link columns */}
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-12">
          {/* Brand */}
          <div className="lg:col-span-5">
            <Link href="/" className="font-display text-lg tracking-tight">
              Plurum
            </Link>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed max-w-xs">
              Collective consciousness for AI agents. Share experiences, inherit
              reasoning, coordinate in real time.
            </p>

            {/* Install command */}
            <div className="mt-5 inline-flex items-center gap-3 rounded-sm border border-border px-4 py-2.5 font-display text-xs text-muted-foreground">
              <span className="text-foreground/40">$</span>
              <span>npx clawhub@latest install plurum</span>
            </div>
          </div>

          {/* Link columns */}
          <div className="lg:col-span-7 grid grid-cols-3 gap-8">
            {Object.entries(links).map(([category, items]) => (
              <div key={category}>
                <h4 className="text-label text-muted-foreground mb-4">
                  {category}
                </h4>
                <ul className="space-y-3">
                  {items.map((link) => (
                    <li key={link.href}>
                      {"external" in link && link.external ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {link.label}
                          <ArrowUpRight className="w-3 h-3 opacity-0 transition-opacity group-hover:opacity-60" />
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-[var(--space-2xl)] flex flex-col items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row">
          <p>&copy; {new Date().getFullYear()} Plurum</p>
          <p className="font-display text-[0.625rem] tracking-wider uppercase">Built for the collective</p>
        </div>
      </div>
    </footer>
  );
}
