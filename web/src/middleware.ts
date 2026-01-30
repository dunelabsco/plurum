import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Routes that require authentication
const protectedRoutes = [
  "/overview",
  "/blueprints",
  "/search",
  "/api-keys",
  "/docs",
  "/settings",
];

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

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
          supabaseResponse = NextResponse.next({
            request,
          });
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

  const pathname = request.nextUrl.pathname;

  // Handle auth code on root — Supabase redirects password reset here
  if (pathname === "/" && request.nextUrl.searchParams.has("code")) {
    const url = request.nextUrl.clone();
    const code = url.searchParams.get("code")!;
    url.pathname = "/auth/callback";
    url.searchParams.delete("code");
    url.searchParams.set("code", code);
    url.searchParams.set("next", "/reset-password");
    return NextResponse.redirect(url);
  }

  // Check if route is protected
  const isProtectedRoute = protectedRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  // Protect platform routes
  if (isProtectedRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Redirect logged-in users from login to overview
  if (pathname === "/login" && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/overview";
    return NextResponse.redirect(url);
  }

  // Redirect old dashboard routes to new routes
  if (pathname.startsWith("/dashboard")) {
    const url = request.nextUrl.clone();
    if (pathname === "/dashboard") {
      url.pathname = "/overview";
    } else if (pathname.startsWith("/dashboard/blueprints")) {
      url.pathname = pathname.replace("/dashboard/blueprints", "/blueprints");
    } else {
      url.pathname = "/overview";
    }
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/",
    "/overview/:path*",
    "/blueprints/:path*",
    "/search/:path*",
    "/api-keys/:path*",
    "/docs/:path*",
    "/settings/:path*",
    "/login",
    "/dashboard/:path*",
  ],
};
