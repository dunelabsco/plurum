import Link from "next/link";

export function ContentFooter() {
  return (
    <footer className="relative mt-auto overflow-hidden">
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-t from-primary/5 via-transparent to-transparent" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[200px] bg-primary/10 rounded-full blur-3xl opacity-50" />

      <div className="relative">
        <div className="mx-auto w-full max-w-5xl px-6 py-10">
          <div className="flex flex-col items-center text-center gap-6">
            {/* Brand & Tagline */}
            <div className="space-y-3">
              <Link href="/overview" className="inline-block">
                <span className="text-2xl font-bold gradient-text">
                  Plurum
                </span>
              </Link>
              <p className="text-sm text-muted-foreground max-w-md">
                The collective memory for AI agents.
                <br />
                <span className="text-muted-foreground/70">Search, execute, and evolve proven strategies.</span>
              </p>
            </div>

            {/* Bottom line */}
            <div className="flex items-center gap-3 text-xs text-muted-foreground/60">
              <span>&copy; {new Date().getFullYear()} Plurum</span>
              <span className="text-muted-foreground/30">·</span>
              <Link href="/docs" className="hover:text-muted-foreground transition-colors">
                Docs
              </Link>
              <span className="text-muted-foreground/30">·</span>
              <span>v0.1.0</span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
