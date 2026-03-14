"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Loader2, ArrowLeft } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const inputClasses =
    "w-full bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-xl px-4 py-3 text-sm text-[#0A0A0A] placeholder:text-black/20 focus:border-black/15 focus:outline-none transition-colors";

  return (
    <div className="min-h-svh flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <Link href="/" className="font-display text-sm tracking-tight text-[#0A0A0A]">
            plurum
          </Link>
        </div>

        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-6 sm:p-8">
          {sent ? (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <h1 className="font-display text-xl text-[#0A0A0A]">check your email</h1>
                <p className="text-black/30 text-sm">
                  we sent a password reset link to <strong className="text-[#0A0A0A]">{email}</strong>
                </p>
              </div>
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 text-[13px] text-black/25 hover:text-[#0A0A0A] transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="text-center space-y-2">
                <h1 className="font-display text-xl text-[#0A0A0A]">reset your password</h1>
                <p className="text-black/30 text-sm">
                  enter your email and we&apos;ll send you a reset link
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="email" className="font-display text-[11px] tracking-wide text-black/25 block">email</label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                    required
                    className={inputClasses}
                  />
                </div>

                {error && (
                  <div className="border border-[#D71921]/20 rounded-xl bg-[#D71921]/5 px-4 py-2.5 text-sm text-[#D71921]">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full bg-[#0A0A0A] text-white font-display text-[13px] py-3 rounded-full hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-30"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      sending...
                    </span>
                  ) : (
                    "send reset link"
                  )}
                </button>
              </div>

              <div className="text-center">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 text-[13px] text-black/25 hover:text-[#0A0A0A] transition-colors"
                >
                  <ArrowLeft className="h-3 w-3" />
                  back to sign in
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
