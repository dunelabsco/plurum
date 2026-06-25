"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Loader2 } from "lucide-react";
import { OAuthButtons, OAuthDivider } from "@/components/auth/oauth-buttons";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setMessage(null);

    if (password !== confirmPassword) {
      setError("passwords do not match");
      setIsLoading(false);
      return;
    }

    if (password.length < 8) {
      setError("password must be at least 8 characters");
      setIsLoading(false);
      return;
    }

    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      setMessage("check your email to confirm your account.");
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
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="text-center space-y-2">
              <h1 className="font-display text-xl text-[#0A0A0A]">create an account</h1>
              <p className="text-black/30 text-sm">
                get started with plurum today
              </p>
            </div>

            <OAuthButtons next="/dashboard" />

            <OAuthDivider />

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

              <div className="space-y-2">
                <label htmlFor="password" className="font-display text-[11px] tracking-wide text-black/25 block">password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="create a password"
                  required
                  className={inputClasses}
                />
                <p className="text-[11px] text-black/20">
                  must be at least 8 characters
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="confirm-password" className="font-display text-[11px] tracking-wide text-black/25 block">confirm password</label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="confirm your password"
                  required
                  className={inputClasses}
                />
              </div>

              {error && (
                <div className="border border-[#D71921]/20 rounded-xl bg-[#D71921]/5 px-4 py-2.5 text-sm text-[#D71921]">
                  {error}
                </div>
              )}

              {message && (
                <div className="border border-black/[0.06] rounded-xl bg-white/60 px-4 py-2.5 text-sm text-[#0A0A0A]">
                  {message}
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
                    creating account...
                  </span>
                ) : (
                  "create account"
                )}
              </button>

              <p className="text-center text-[11px] text-black/25 leading-relaxed">
                by creating an account, you agree to our{" "}
                <Link href="/terms" className="text-black/40 hover:text-[#0A0A0A] hover:underline">
                  terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" className="text-black/40 hover:text-[#0A0A0A] hover:underline">
                  privacy policy
                </Link>
                .
              </p>
            </div>

            <p className="text-center text-[13px] text-black/25">
              already have an account?{" "}
              <Link href="/login" className="text-[#0A0A0A] hover:underline">
                sign in
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
