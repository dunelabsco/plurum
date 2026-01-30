"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-svh flex items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Loading...</span>
          </div>
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
  const supabase = createClient();

  useEffect(() => {
    const tokenHash = searchParams.get("token_hash");
    const type = searchParams.get("type");

    if (tokenHash && type === "recovery") {
      supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" }).then(({ error }) => {
        if (error) {
          setError("Reset link is invalid or expired. Please request a new one.");
        }
        setIsVerifying(false);
      });
    } else {
      // Check if user already has a session
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (!user) {
          setError("No reset session found. Please request a new reset link.");
        }
        setIsVerifying(false);
      });
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      setIsLoading(false);
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      setIsLoading(false);
      return;
    }

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setSuccess(true);
      setTimeout(() => {
        router.push("/overview");
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
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Verifying reset link...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <Link href="/" className="flex items-center gap-2 font-medium">
            <span className="text-xl font-bold gradient-text">Plurum</span>
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            {success ? (
              <div className="flex flex-col gap-6 text-center">
                <div className="flex flex-col items-center gap-2">
                  <h1 className="text-2xl font-bold">Password updated</h1>
                  <p className="text-muted-foreground text-sm">
                    Redirecting you to the dashboard...
                  </p>
                </div>
              </div>
            ) : error && !password ? (
              <div className="flex flex-col gap-6 text-center">
                <div className="flex flex-col items-center gap-2">
                  <h1 className="text-2xl font-bold">Link expired</h1>
                  <p className="text-muted-foreground text-sm text-balance">
                    {error}
                  </p>
                </div>
                <Link
                  href="/forgot-password"
                  className="inline-flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-4 py-2 rounded-lg text-sm transition-colors"
                >
                  Request new link
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-6">
                <div className="flex flex-col items-center gap-2 text-center">
                  <h1 className="text-2xl font-bold">Set new password</h1>
                  <p className="text-muted-foreground text-sm text-balance">
                    Enter your new password below
                  </p>
                </div>

                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="password">New Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter new password"
                      required
                      className="bg-background/50"
                    />
                    <p className="text-xs text-muted-foreground">
                      Must be at least 8 characters
                    </p>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="confirm-password">Confirm Password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm new password"
                      required
                      className="bg-background/50"
                    />
                  </div>

                  {error && (
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-sm text-destructive">
                      {error}
                    </div>
                  )}

                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Updating...
                      </>
                    ) : (
                      "Update password"
                    )}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      <div className="relative hidden lg:block bg-muted">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-background to-purple-500/20" />
        <div className="absolute inset-0 dot-pattern opacity-30" />
        <div className="absolute inset-0 flex flex-col items-center justify-center p-12">
          <div className="max-w-md text-center">
            <h2 className="text-3xl font-bold mb-4 gradient-text">
              Almost There
            </h2>
            <p className="text-muted-foreground text-lg">
              Set your new password to regain access to your account.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
