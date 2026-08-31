import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, isAdmin } from "@/lib/session";

/**
 * Page-level gate.
 *
 * This verifies the cookie's signature rather than merely checking it exists.
 * The previous version accepted any cookie whose value was the fixed string
 * "authenticated_session_active", which anyone could type into devtools.
 *
 * It is only half the story: middleware runs on the Edge runtime, so it cannot
 * reach the database to see whether an account has since been disabled, and it
 * only runs for the paths matched below. Every API route calls requireUser()
 * for the authoritative check.
 */
export async function middleware(req) {
  const { pathname } = req.nextUrl;
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/") {
    return NextResponse.redirect(new URL(session ? "/dashboard" : "/login", req.url));
  }

  if (pathname.startsWith("/login")) {
    return session ? NextResponse.redirect(new URL("/dashboard", req.url)) : NextResponse.next();
  }

  if (!session) {
    // Where they were headed, so login can send them back rather than always
    // dumping them on the dashboard.
    const login = new URL("/login", req.url);
    if (pathname !== "/dashboard") login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  // User management is admin-only. A viewer who types the URL lands on the
  // dashboard instead of a page whose every request would 403.
  if (pathname.startsWith("/users") && !isAdmin(session)) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/dashboard/:path*", "/users/:path*"],
};
