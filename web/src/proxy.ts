import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeAuthRedirectPath } from "@/lib/auth/safe-redirect";

const protectedPaths = ["/dashboard"];

const legacyRedirects: Record<string, string> = {
  "/overview": "/dashboard",
  "/api-keys": "/dashboard/agents",
  "/settings": "/dashboard/settings",
  "/agents/me": "/dashboard/agents",
};

export async function proxy(request: NextRequest) {
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
  let refreshedCookies: Parameters<typeof supabaseResponse.cookies.set>[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          refreshedCookies = cookiesToSet.map(({ name, value, options }) => [
            name,
            value,
            options,
          ]);
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
    return redirectWithRefreshedCookies(url, refreshedCookies);
  }

  if (pathname === "/login" && user) {
    const next = safeAuthRedirectPath(request.nextUrl.searchParams.get("next"));
    return redirectWithRefreshedCookies(
      new URL(next, request.url),
      refreshedCookies
    );
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/oauth/consent",
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

function redirectWithRefreshedCookies(
  url: URL,
  cookiesToSet: Parameters<NextResponse["cookies"]["set"]>[]
) {
  const response = NextResponse.redirect(url);
  cookiesToSet.forEach((cookie) => response.cookies.set(...cookie));
  return response;
}
