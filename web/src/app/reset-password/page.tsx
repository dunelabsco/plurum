"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Loader2 } from "lucide-react";

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-svh flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-black/20" />
        </div>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [supabase] = useState(createClient);

  useEffect(() => {
    let active = true;

    async function verifyResetSession() {
      try {
        const tokenHash = searchParams.get("token_hash");
        const type = searchParams.get("type");

        if (tokenHash && type === "recovery") {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: "recovery",
          });
          if (!active) return;
          if (error) {
            setError("reset link is invalid or expired. please request a new one.");
          }
        } else {
          const { data: { user } } = await supabase.auth.getUser();
          if (!active) return;
          if (!user) {
            setError("no reset session found. please request a new reset link.");
          }
        }
      } catch {
        if (active) {
          setError("could not verify the reset link. please try again.");
        }
      } finally {
        if (active) setIsVerifying(false);
      }
    }

    void verifyResetSession();
    return () => {
      active = false;
    };
  }, [searchParams, supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

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
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setSuccess(true);
      setTimeout(() => {
        router.push("/dashboard");
      }, 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  if (isVerifying) {
    return (
      <div className="min-h-svh flex items-center justify-center">
        <div className="flex items-center gap-3 text-black/25 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>verifying reset link...</span>
        </div>
      </div>
    );
  }

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
          {success ? (
            <div className="space-y-2 text-center">
              <h1 className="font-display text-xl text-[#0A0A0A]">password updated</h1>
              <p className="text-black/30 text-sm">
                redirecting you to the dashboard...
              </p>
            </div>
          ) : error && !password ? (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <h1 className="font-display text-xl text-[#0A0A0A]">link expired</h1>
                <p className="text-black/30 text-sm">{error}</p>
              </div>
              <Link
                href="/forgot-password"
                className="inline-flex items-center justify-center bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
              >
                request new link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="text-center space-y-2">
                <h1 className="font-display text-xl text-[#0A0A0A]">set new password</h1>
                <p className="text-black/30 text-sm">
                  enter your new password below
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="password" className="font-display text-[11px] tracking-wide text-black/25 block">new password</label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="enter new password"
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
                    placeholder="confirm new password"
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
                      updating...
                    </span>
                  ) : (
                    "update password"
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
