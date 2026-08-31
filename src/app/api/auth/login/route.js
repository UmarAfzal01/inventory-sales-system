import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL, ensureSchema } from "@/lib/schema";
import { verifyPassword } from "@/lib/password";
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";
import { findUserByEmail, seedAdminIfEmpty, publicUser } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    await dbConnect();
    await ensureSchema(mongoose.connection.db);

    // Bootstraps the first admin from ADMIN_USERNAME/ADMIN_PASSWORD, and only
    // while no users exist at all.
    await seedAdminIfEmpty();

    const body = await req.json().catch(() => ({}));
    // `username` is still accepted so an old cached login page keeps working.
    const email = body.email ?? body.username;
    const password = body.password;

    const user = await findUserByEmail(email);
    const ok = user && !user.disabled && (await verifyPassword(password, user.passwordHash, user.salt));

    // One message for every failure. Distinguishing "no such account" from
    // "wrong password" turns the login form into a way to enumerate who has one.
    if (!ok) {
      return NextResponse.json(
        { success: false, error: "Incorrect email or password." },
        { status: 401 }
      );
    }

    await mongoose.connection.db
      .collection(COL.USERS)
      .updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    const token = await signSession({
      userId: String(user._id),
      email: user.email,
      role: user.role,
    });

    const response = NextResponse.json({ success: true, user: publicUser(user) });
    response.cookies.set({
      name: SESSION_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return response;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ success: false, error: "Server authentication error" }, { status: 500 });
  }
}
