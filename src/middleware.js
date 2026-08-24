import { NextResponse } from "next/server";

export function middleware(req) {
  const { pathname } = req.nextUrl;
  const authToken = req.cookies.get("auth_token")?.value;

  // 1. If hitting root '/', redirect based on auth status
  if (pathname === "/") {
    if (authToken) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // 2. If trying to visit login while already authenticated, push to dashboard
  if (pathname.startsWith("/login") && authToken) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // 3. Protect internal routes (e.g., /dashboard or others) if unauthenticated
  const isPublicRoute = pathname.startsWith("/login") || pathname.startsWith("/api");
  if (!isPublicRoute && !authToken) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/dashboard/:path*"],
};