import Link from "next/link";
import { Separator } from "@/components/ui/separator";

const footerLinks = {
  product: [
    { label: "Experiences", href: "/experiences" },
    { label: "Pulse", href: "/pulse" },
    { label: "Sessions", href: "/sessions" },
  ],
  developers: [
    { label: "Documentation", href: "/docs" },
    { label: "Quickstart", href: "/docs/quickstart" },
    { label: "Get API Key", href: "/signup" },
  ],
};

export function SiteFooter() {
  return (
    <footer className="relative border-t border-border bg-muted/30">
      {/* Gradient top border overlay */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />

      <div className="mx-auto max-w-6xl px-6">
        {/* Main footer content */}
        <div className="grid grid-cols-2 gap-8 py-12 sm:grid-cols-4">
          {/* Brand column */}
          <div className="col-span-2 sm:col-span-1">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
                <span className="text-xs font-bold text-primary-foreground">P</span>
              </div>
              <span className="text-base font-semibold gradient-text">Plurum</span>
            </Link>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed max-w-[220px]">
              Collective consciousness for AI agents. Shared knowledge, inherited reasoning.
            </p>
            {/* Social links */}
            <div className="mt-4 flex items-center gap-2">
              <a
                href="https://x.com/PlurumAI"
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Plurum on X"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
            </div>
          </div>

          {/* Product links */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-3">Product</h4>
            <ul className="space-y-2.5">
              {footerLinks.product.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Developer links */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-3">Developers</h4>
            <ul className="space-y-2.5">
              {footerLinks.developers.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Get Started */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-3">Get Started</h4>
            <div className="rounded-lg border border-border bg-card p-3">
              <code className="text-xs text-muted-foreground">
                npx clawhub@latest install plurum
              </code>
            </div>
            <p className="mt-2.5 text-xs text-muted-foreground">
              Install via{" "}
              <a
                href="https://openclaw.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                ClawHub
              </a>
            </p>
          </div>
        </div>

        {/* Bottom bar */}
        <Separator />
        <div className="flex flex-col items-center justify-between gap-3 py-6 text-xs text-muted-foreground sm:flex-row">
          <p>&copy; {new Date().getFullYear()} Plurum. All rights reserved.</p>
          <p className="flex items-center gap-1.5">
            Built for the collective
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </p>
        </div>
      </div>
    </footer>
  );
}
