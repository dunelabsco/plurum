"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Menu, ChevronDown, LogOut, Key, Settings, ScrollText, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const navLinks = [
  { href: "/experiences", label: "Experiences" },
  { href: "/pulse", label: "Pulse" },
  { href: "/docs", label: "Docs" },
];

export function TopNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [totalAgents, setTotalAgents] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [mounted, setMounted] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    setMounted(true);
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ? { email: data.user.email ?? undefined } : null);
    });
    const apiUrl = process.env.NEXT_PUBLIC_PLURUM_API_URL || "http://localhost:8000";
    fetch(`${apiUrl}/api/v1/pulse/status`)
      .then((r) => r.json())
      .then((d) => setTotalAgents(d.total_agents ?? null))
      .catch(() => {});

    const handleScroll = () => setScrolled(window.scrollY > 0);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  return (
    <nav
      className={cn(
        "fixed z-50 top-3 left-4 right-4 sm:left-6 sm:right-6 mx-auto max-w-6xl rounded-2xl border border-border/50 backdrop-blur-2xl transition-shadow duration-300",
        "bg-white/75 dark:bg-white/[0.06] supports-[backdrop-filter]:bg-white/60 dark:supports-[backdrop-filter]:bg-white/[0.04]",
        scrolled
          ? "shadow-lg shadow-black/[0.06] dark:shadow-black/[0.25]"
          : "shadow-sm shadow-black/[0.02] dark:shadow-black/[0.12]"
      )}
    >
      <div className="mx-auto px-6">
        <div className="flex h-14 items-center justify-between">
          {/* Left: Logo + Nav + Agents */}
          <div className="flex items-center gap-8">
            {/* Logo mark + wordmark */}
            <Link href="/" className="flex items-center gap-2">
              <span className="text-lg font-semibold gradient-text">Plurum</span>
            </Link>

            {/* Desktop nav links */}
            <div className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "relative px-3 py-2 text-sm font-medium transition-colors",
                    pathname.startsWith(link.href)
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {link.label}
                  {pathname.startsWith(link.href) && (
                    <span className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-4 rounded-full bg-primary" />
                  )}
                </Link>
              ))}
            </div>

            {/* Agents counter badge */}
            {totalAgents !== null && (
              <div className="hidden md:flex items-center gap-2 ml-1 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="tabular-nums">{totalAgents.toLocaleString()}</span>
                <span className="text-muted-foreground/70">agents</span>
              </div>
            )}
          </div>

          {/* Right: Theme + Auth */}
          <div className="flex items-center gap-1.5">
            <ThemeToggle />

            <Separator orientation="vertical" className="mx-1 h-5 hidden sm:block" />

            {mounted && (
              <>
                {user ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="gap-2 rounded-full px-2 text-sm">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 ring-1 ring-primary/20">
                          <User className="h-3.5 w-3.5 text-primary" />
                        </div>
                        <span className="hidden sm:inline text-muted-foreground max-w-[120px] truncate text-xs">
                          {user.email}
                        </span>
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem asChild>
                        <Link href="/sessions" className="flex items-center gap-2">
                          <ScrollText className="h-4 w-4" />
                          My Sessions
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/api-keys" className="flex items-center gap-2">
                          <Key className="h-4 w-4" />
                          API Keys
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/settings" className="flex items-center gap-2">
                          <Settings className="h-4 w-4" />
                          Settings
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={handleSignOut} className="flex items-center gap-2">
                        <LogOut className="h-4 w-4" />
                        Sign out
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <div className="flex items-center gap-2">
                    <Link
                      href="/login"
                      className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:inline"
                    >
                      Sign in
                    </Link>
                    <Button asChild size="sm" className="rounded-full shadow-sm shadow-primary/20">
                      <Link href="/signup">Get API Key</Link>
                    </Button>
                  </div>
                )}
              </>
            )}

            {/* Mobile Sheet menu */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden h-9 w-9">
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">Menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 pt-12">
                <SheetHeader>
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col gap-1">
                  {navLinks.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                        pathname.startsWith(link.href)
                          ? "bg-accent text-foreground font-medium"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      )}
                    >
                      {link.label}
                    </Link>
                  ))}
                </nav>

                {/* Agents counter in mobile */}
                {totalAgents !== null && (
                  <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    <span className="tabular-nums">{totalAgents.toLocaleString()} agents</span>
                    <span>in the collective</span>
                  </div>
                )}

                {user && (
                  <>
                    <Separator className="my-4" />
                    <nav className="flex flex-col gap-1">
                      <Link
                        href="/sessions"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      >
                        <ScrollText className="h-4 w-4" />
                        My Sessions
                      </Link>
                      <Link
                        href="/api-keys"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      >
                        <Key className="h-4 w-4" />
                        API Keys
                      </Link>
                      <Link
                        href="/settings"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      >
                        <Settings className="h-4 w-4" />
                        Settings
                      </Link>
                    </nav>
                  </>
                )}
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </nav>
  );
}
