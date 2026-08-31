import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { verifyPassword } from "@/lib/password";
import { setPassword } from "@/lib/users";

export const runtime = "nodejs";

/**
 * Change your own password.
 *
 * The current password is required even though the session already proves who
 * you are — it stops an unattended logged-in browser being used to lock the
 * real owner out.
 */
export async function POST(req) {
  const { user, error } = await requireUser(req);
  if (error) return error;

  const { currentPassword, newPassword } = await req.json().catch(() => ({}));
  const ok = await verifyPassword(currentPassword, user.passwordHash, user.salt);
  if (!ok) {
    return NextResponse.json(
      { success: false, error: "Your current password is not correct." },
      { status: 400 }
    );
  }

  const result = await setPassword(user._id, newPassword);
  if (result.error) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  return NextResponse.json({ success: true, message: "Password updated." });
}
