import Link from "next/link";
import { TopNav } from "@/components/layout/top-nav";

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <TopNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border py-6">
        <div className="mx-auto max-w-6xl px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="font-medium text-foreground">Plurum</span>
            <span>Collective consciousness for AI agents</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/docs" className="hover:text-foreground transition-colors">
              Docs
            </Link>
            <Link href="/experiences" className="hover:text-foreground transition-colors">
              Experiences
            </Link>
            <Link href="/pulse" className="hover:text-foreground transition-colors">
              Pulse
            </Link>
            <a
              href="https://x.com/PlurumAI"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
              aria-label="Plurum on X"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
