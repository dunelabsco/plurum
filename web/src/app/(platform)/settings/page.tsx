"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  User,
  Mail,
  LogOut,
  Loader2,
  Settings,
  Shield,
  Bell,
  Palette,
  Calendar,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface UserProfile {
  email: string;
  name?: string;
  avatar?: string;
  createdAt: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    async function loadUser() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        setUser({
          email: user.email || "",
          name: user.user_metadata?.full_name || user.user_metadata?.name,
          avatar: user.user_metadata?.avatar_url,
          createdAt: user.created_at,
        });
      }
      setIsLoading(false);
    }
    loadUser();
  }, [supabase.auth]);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    } catch (error) {
      toast.error("Failed to sign out");
      setIsSigningOut(false);
    }
  };

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user?.email?.slice(0, 2).toUpperCase() || "U";

  if (isLoading) {
    return (
      <>
        <PageHeader />
        <div className="flex-1 flex items-center justify-center">
          <div className="relative">
            <div className="h-16 w-16 rounded-full border-4 border-primary/20 animate-pulse" />
            <Loader2 className="absolute inset-0 m-auto h-8 w-8 animate-spin text-primary" />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-8 space-y-8">
          {/* Header */}
          <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-primary/10 p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />

            <div className="relative z-10 flex items-center gap-6">
              <Avatar className="h-20 w-20 ring-2 ring-primary/20 ring-offset-2 ring-offset-background">
                <AvatarImage src={user?.avatar} alt={user?.name || "User"} />
                <AvatarFallback className="text-xl font-semibold bg-primary/10 text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div>
                <h1 className="text-2xl font-bold tracking-tight mb-1">
                  {user?.name || "User"}
                </h1>
                <p className="text-muted-foreground">{user?.email}</p>
                <div className="flex items-center gap-2 mt-2">
                  <Badge variant="secondary" className="text-xs">
                    <Calendar className="h-3 w-3 mr-1" />
                    Member since{" "}
                    {user?.createdAt
                      ? new Date(user.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          year: "numeric",
                        })
                      : ""}
                  </Badge>
                </div>
              </div>
            </div>
          </section>

          {/* Profile Section */}
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <User className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Profile</h2>
                <p className="text-sm text-muted-foreground">Your account information</p>
              </div>
            </div>

            <div className="rounded-xl border border-border/50 bg-card/30 p-6 space-y-6">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Display Name</Label>
                <Input
                  value={user?.name || ""}
                  disabled
                  placeholder="Not set"
                  className="bg-muted/30"
                />
                <p className="text-xs text-muted-foreground">
                  Display name is managed through your authentication provider
                </p>
              </div>

              <Separator className="bg-border/50" />

              <div className="space-y-2">
                <Label className="text-muted-foreground">Email Address</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={user?.email || ""}
                    disabled
                    className="bg-muted/30"
                  />
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/30">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Account Section */}
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/10">
                <Shield className="h-5 w-5 text-red-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Account</h2>
                <p className="text-sm text-muted-foreground">Manage your account access</p>
              </div>
            </div>

            <div className="rounded-xl border border-border/50 bg-card/30 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">Sign Out</h3>
                  <p className="text-sm text-muted-foreground">
                    Sign out of your account on this device
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setShowSignOutDialog(true)}
                  className="border-red-500/20 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign Out
                </Button>
              </div>
            </div>
          </section>

          {/* Preferences (Coming Soon) */}
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/50">
                <Settings className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-muted-foreground">Preferences</h2>
                <p className="text-sm text-muted-foreground">Customize your experience</p>
              </div>
            </div>

            <div className="rounded-xl border border-dashed border-border/50 bg-card/20 p-6">
              <div className="flex flex-col items-center text-center py-4">
                <div className="flex gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/30">
                    <Bell className="h-5 w-5 text-muted-foreground/50" />
                  </div>
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/30">
                    <Palette className="h-5 w-5 text-muted-foreground/50" />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Preference settings coming soon. You&apos;ll be able to customize
                  notifications, default search filters, and more.
                </p>
              </div>
            </div>
          </section>
        </div>

        <ContentFooter />
      </div>

      {/* Sign Out Dialog */}
      <Dialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 mb-4 mx-auto">
              <LogOut className="h-7 w-7 text-red-400" />
            </div>
            <DialogTitle className="text-center">Sign Out</DialogTitle>
            <DialogDescription className="text-center">
              Are you sure you want to sign out? You&apos;ll need to sign in again
              to access your account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setShowSignOutDialog(false)}
              disabled={isSigningOut}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="flex-1 bg-red-500 hover:bg-red-600 text-white"
            >
              {isSigningOut ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing out...
                </>
              ) : (
                "Sign Out"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
