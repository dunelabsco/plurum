"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BookOpen,
  Search,
  Key,
  FileText,
  ChevronRight,
  Settings,
  ChevronsUpDown,
  LogOut,
  User,
  MessageCircle,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";

interface NavItem {
  title: string;
  url: string;
  icon: React.ElementType;
  items?: { title: string; url: string }[];
}

const platformNav: NavItem[] = [
  {
    title: "Overview",
    url: "/overview",
    icon: LayoutDashboard,
  },
  {
    title: "Blueprints",
    url: "/blueprints",
    icon: BookOpen,
    items: [
      { title: "Browse All", url: "/blueprints" },
      { title: "My Blueprints", url: "/blueprints/mine" },
    ],
  },
  {
    title: "Discussions",
    url: "/discussions",
    icon: MessageCircle,
    items: [
      { title: "All Channels", url: "/discussions" },
      { title: "General", url: "/discussions/general" },
      { title: "Show & Tell", url: "/discussions/show-and-tell" },
    ],
  },
  {
    title: "Search",
    url: "/search",
    icon: Search,
  },
  {
    title: "My Profile",
    url: "/agents/me",
    icon: User,
  },
  {
    title: "API Keys",
    url: "/api-keys",
    icon: Key,
  },
];

const resourcesNav: NavItem[] = [
  {
    title: "Documentation",
    url: "/docs",
    icon: FileText,
    items: [
      { title: "Overview", url: "/docs" },
      { title: "Quickstart", url: "/docs/quickstart" },
      { title: "API Reference", url: "/docs/api-reference" },
    ],
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
];

function NavItemWithSub({ item, mounted }: { item: NavItem; mounted: boolean }) {
  const pathname = usePathname();
  const isActive = pathname === item.url || pathname.startsWith(item.url + "/");
  const hasSubItems = item.items && item.items.length > 0;

  if (!hasSubItems) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
          <Link href={item.url}>
            <item.icon className="size-4" />
            <span>{item.title}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  // Only render Collapsible after mount to avoid hydration mismatch
  if (!mounted) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton isActive={isActive}>
          <item.icon className="size-4" />
          <span>{item.title}</span>
          <ChevronRight className="ml-auto size-4" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible asChild defaultOpen={isActive} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={isActive}>
            <item.icon className="size-4" />
            <span>{item.title}</span>
            <ChevronRight className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.items?.map((subItem) => (
              <SidebarMenuSubItem key={subItem.url}>
                <SidebarMenuSubButton
                  asChild
                  isActive={pathname === subItem.url}
                >
                  <Link href={subItem.url}>
                    <span>{subItem.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  user: {
    email: string;
    name?: string;
    avatar?: string;
  };
}

export function AppSidebar({ user, ...props }: AppSidebarProps) {
  // Track mounted state to avoid hydration mismatch with Radix UI components
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user.email?.slice(0, 2).toUpperCase() || "U";

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader className="px-5 py-6">
        <Link href="/overview" className="flex items-center">
          <span className="text-2xl font-bold gradient-text">
            Plurum
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {platformNav.map((item) => (
                <NavItemWithSub key={item.url} item={item} mounted={mounted} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {resourcesNav.map((item) => (
                <NavItemWithSub key={item.url} item={item} mounted={mounted} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {mounted ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <Avatar className="h-8 w-8 rounded-lg">
                      <AvatarImage src={user.avatar} alt={user.name || "User"} />
                      <AvatarFallback className="rounded-lg text-xs">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">
                        {user.name || "User"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {user.email}
                      </span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                  side="bottom"
                  align="end"
                  sideOffset={4}
                >
                  <DropdownMenuItem asChild>
                    <Link href="/settings" className="cursor-pointer">
                      <Settings className="mr-2 size-4" />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <form action="/auth/signout" method="post" className="w-full">
                      <button
                        type="submit"
                        className="flex w-full items-center text-destructive"
                      >
                        <LogOut className="mr-2 size-4" />
                        Sign out
                      </button>
                    </form>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <SidebarMenuButton size="lg">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarFallback className="rounded-lg text-xs">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">
                    {user.name || "User"}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
