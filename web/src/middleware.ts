import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const protectedPaths = ["/dashboard"];

const legacyRedirects: Record<string, string> = {
  "/overview": "/dashboard",
  "/api-keys": "/dashboard/agents",
  "/settings": "/dashboard/settings",
  "/agents/me": "/dashboard/agents",
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle legacy redirects first
  for (const [from, to] of Object.entries(legacyRedirects)) {
    if (pathname === from || pathname.startsWith(from + "/")) {
      const url = request.nextUrl.clone();
      url.pathname = to;
      return NextResponse.redirect(url);
    }
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isProtected = protectedPaths.some(
    (path) => pathname === path || pathname.startsWith(path + "/")
  );

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (pathname === "/login" && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/login",
    "/overview/:path*",
    "/overview",
    "/api-keys/:path*",
    "/api-keys",
    "/settings/:path*",
    "/settings",
    "/agents/me/:path*",
    "/agents/me",
  ],
};
