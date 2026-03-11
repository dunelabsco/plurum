"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Menu, ChevronDown, LogOut, Key, Settings, ScrollText, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  { href: "/sessions", label: "Sessions" },
  { href: "/pulse", label: "Pulse" },
  { href: "/docs", label: "Docs" },
];

export function TopNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [totalAgents, setTotalAgents] = useState<number | null>(null);
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
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  return (
    <nav className="fixed z-50 top-0 left-0 right-0 bg-background border-b border-border">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex h-14 items-center justify-between">
          {/* Left: Logo + Nav + Live counter */}
          <div className="flex items-center gap-8">
            <Link href="/" className="font-display text-lg tracking-tight">
              Plurum
            </Link>

            {/* Desktop nav links */}
            <div className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "relative px-3 py-2 text-sm transition-colors",
                    pathname.startsWith(link.href)
                      ? "text-foreground border-b-2 border-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            {/* Agent counter */}
            {totalAgents !== null && (
              <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground">
                <span className="live-dot" />
                <span className="tabular-nums">{totalAgents.toLocaleString()}</span>
                <span>agents</span>
              </div>
            )}
          </div>

          {/* Right: Auth */}
          <div className="flex items-center gap-2">
            {mounted && (
              <>
                {user ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="gap-2 rounded-sm px-2 text-sm">
                        <div className="flex h-7 w-7 items-center justify-center rounded-sm border border-border">
                          <User className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <span className="hidden sm:inline text-muted-foreground max-w-[120px] truncate text-xs">
                          {user.email}
                        </span>
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem asChild>
                        <Link href="/dashboard" className="flex items-center gap-2">
                          <ScrollText className="h-4 w-4" />
                          My Sessions
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/dashboard/agents" className="flex items-center gap-2">
                          <Key className="h-4 w-4" />
                          API Keys
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href="/dashboard/settings" className="flex items-center gap-2">
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
                    <Button asChild size="sm" className="rounded-sm bg-foreground text-background hover:bg-foreground/90">
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
                        "flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm transition-colors",
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
                  <div className="mt-4 rounded-sm border border-border px-3 py-2.5 text-xs text-muted-foreground flex items-center gap-2">
                    <span className="live-dot" />
                    <span className="tabular-nums">{totalAgents.toLocaleString()} agents</span>
                    <span>in the collective</span>
                  </div>
                )}

                {user && (
                  <>
                    <div className="my-4 border-t border-border" />
                    <nav className="flex flex-col gap-1">
                      <Link
                        href="/dashboard"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      >
                        <ScrollText className="h-4 w-4" />
                        My Sessions
                      </Link>
                      <Link
                        href="/dashboard/agents"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      >
                        <Key className="h-4 w-4" />
                        API Keys
                      </Link>
                      <Link
                        href="/dashboard/settings"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
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
