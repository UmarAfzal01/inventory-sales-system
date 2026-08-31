import { NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import { COL } from "@/lib/schema";
import { SESSION_COOKIE, verifySession, isAdmin } from "@/lib/session";

/**
 * Authorisation for route handlers.
 *
 * The middleware also checks the cookie, but that is not enough on its own:
 * middleware only runs for matched paths, and an API route is reachable
 * directly regardless. Every route re-checks here.
 *
 * The signed token is verified first — cheap, no I/O — and the user is then
 * re-read from the database, because a token stays valid for seven days and
 * would otherwise keep working after the account was disabled or deleted.
 */
export async function requireUser(req, { admin = false } = {}) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session) {
    return { error: NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 }) };
  }
  if (admin && !isAdmin(session)) {
    return {
      error: NextResponse.json(
        { success: false, error: "This action requires an admin account." },
        { status: 403 }
      ),
    };
  }

  await dbConnect();
  let user = null;
  try {
    user = await mongoose.connection.db
      .collection(COL.USERS)
      .findOne({ _id: new mongoose.Types.ObjectId(String(session.userId)) });
  } catch {
    user = null;
  }

  if (!user || user.disabled) {
    return {
      error: NextResponse.json(
        { success: false, error: "Your account is no longer active." },
        { status: 401 }
      ),
    };
  }
  // Role is taken from the record, not the token: an admin demoted to viewer
  // must lose access immediately, not when their cookie happens to expire.
  if (admin && user.role !== "admin") {
    return {
      error: NextResponse.json(
        { success: false, error: "This action requires an admin account." },
        { status: 403 }
      ),
    };
  }

  return { user, session };
}
