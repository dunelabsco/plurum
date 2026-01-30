import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const sidebarUser = {
    email: user.email || "",
    name: user.user_metadata?.full_name || user.user_metadata?.name,
    avatar: user.user_metadata?.avatar_url,
  };

  return (
    <SidebarProvider>
      <AppSidebar user={sidebarUser} />
      <SidebarInset className="flex flex-col">
        <header className="flex h-14 items-center gap-2 px-4 lg:hidden border-b border-border">
          <SidebarTrigger />
          <span className="text-lg font-bold gradient-text">Plurum</span>
        </header>
        <div className="flex-1 flex flex-col pt-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
