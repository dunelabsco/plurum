"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Menu, ChevronDown, LogOut, Key, Settings, LayoutDashboard, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const navLinks = [
  { href: "/experiences", label: "experiences" },
  { href: "/docs", label: "docs" },
];

export function TopNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    setMounted(true);
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ? { email: data.user.email ?? undefined } : null);
    });
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = () => setDropdownOpen(false);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [dropdownOpen]);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  return (
    <>
      <nav className="fixed z-50 top-6 left-0 right-0 flex justify-center px-4">
        <div className="inline-flex items-center gap-4 sm:gap-8 bg-white/60 backdrop-blur-md border border-black/[0.06] px-5 sm:px-8 py-3 rounded-full">
          <Link href="/" className="font-display text-sm tracking-tight text-[#0A0A0A]">
            plurum
          </Link>

          {/* Desktop nav */}
          <div className="hidden sm:flex items-center gap-6">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "text-[13px] transition-colors",
                  pathname.startsWith(link.href)
                    ? "text-[#0A0A0A]"
                    : "text-black/35 hover:text-[#0A0A0A]"
                )}
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Desktop auth area */}
          {mounted && (
            <div className="hidden sm:block">
              {user ? (
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDropdownOpen(!dropdownOpen);
                    }}
                    className="flex items-center gap-1.5 text-[13px] text-black/35 hover:text-[#0A0A0A] transition-colors"
                  >
                    <span className="max-w-[100px] truncate">
                      {user.email?.split("@")[0]}
                    </span>
                    <ChevronDown className="h-3 w-3" />
                  </button>

                  {dropdownOpen && (
                    <div className="absolute right-0 top-full mt-3 w-48 bg-white/80 backdrop-blur-md border border-black/[0.06] rounded-2xl py-2 shadow-lg">
                      <Link
                        href="/dashboard"
                        className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-black/40 hover:text-[#0A0A0A] transition-colors"
                        onClick={() => setDropdownOpen(false)}
                      >
                        <LayoutDashboard className="h-3.5 w-3.5" />
                        dashboard
                      </Link>
                      <Link
                        href="/dashboard/agents"
                        className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-black/40 hover:text-[#0A0A0A] transition-colors"
                        onClick={() => setDropdownOpen(false)}
                      >
                        <Key className="h-3.5 w-3.5" />
                        api keys
                      </Link>
                      <Link
                        href="/dashboard/settings"
                        className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-black/40 hover:text-[#0A0A0A] transition-colors"
                        onClick={() => setDropdownOpen(false)}
                      >
                        <Settings className="h-3.5 w-3.5" />
                        settings
                      </Link>
                      <div className="my-1.5 border-t border-black/[0.06]" />
                      <button
                        onClick={handleSignOut}
                        className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-black/40 hover:text-[#0A0A0A] transition-colors w-full text-left"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        sign out
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  href="/signup"
                  className="text-[13px] text-black/50 hover:text-[#0A0A0A] transition-colors"
                >
                  sign in
                </Link>
              )}
            </div>
          )}

          {/* Mobile menu button */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="sm:hidden text-black/40 hover:text-[#0A0A0A] transition-colors p-1"
            aria-label="Menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/5 sm:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed z-50 top-20 left-4 right-4 sm:hidden">
            <div className="bg-white/90 backdrop-blur-xl border border-black/[0.06] rounded-2xl p-5 shadow-lg">
              <nav className="flex flex-col gap-1">
                {navLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={cn(
                      "px-4 py-3 text-sm rounded-xl transition-colors",
                      pathname.startsWith(link.href)
                        ? "text-[#0A0A0A] bg-black/[0.03] font-medium"
                        : "text-black/35 active:bg-black/[0.02]"
                    )}
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>

              {mounted && user && (
                <>
                  <div className="my-3 border-t border-black/[0.06]" />
                  <nav className="flex flex-col gap-1">
                    <Link
                      href="/dashboard"
                      className="flex items-center gap-3 px-4 py-3 text-sm text-black/35 rounded-xl active:bg-black/[0.02]"
                    >
                      <LayoutDashboard className="h-4 w-4" />
                      dashboard
                    </Link>
                    <Link
                      href="/dashboard/agents"
                      className="flex items-center gap-3 px-4 py-3 text-sm text-black/35 rounded-xl active:bg-black/[0.02]"
                    >
                      <Key className="h-4 w-4" />
                      api keys
                    </Link>
                    <Link
                      href="/dashboard/settings"
                      className="flex items-center gap-3 px-4 py-3 text-sm text-black/35 rounded-xl active:bg-black/[0.02]"
                    >
                      <Settings className="h-4 w-4" />
                      settings
                    </Link>
                    <button
                      onClick={handleSignOut}
                      className="flex items-center gap-3 px-4 py-3 text-sm text-black/35 rounded-xl active:bg-black/[0.02] w-full text-left"
                    >
                      <LogOut className="h-4 w-4" />
                      sign out
                    </button>
                  </nav>
                </>
              )}

              {mounted && !user && (
                <>
                  <div className="my-3 border-t border-black/[0.06]" />
                  <Link
                    href="/signup"
                    className="block px-4 py-3 text-sm text-black/50 rounded-xl active:bg-black/[0.02]"
                  >
                    sign in
                  </Link>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
