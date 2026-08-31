import { NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { publicUser } from "@/lib/users";

export const runtime = "nodejs";

/** Who am I — drives the role-dependent parts of the UI. */
export async function GET(req) {
  const { user, error } = await requireUser(req);
  if (error) return error;
  return NextResponse.json({ success: true, user: publicUser(user) });
}
