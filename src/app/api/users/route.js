import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { ensureSchema } from "@/lib/schema";
import { requireUser } from "@/lib/guard";
import { listUsers, createUser } from "@/lib/users";
import { ROLES } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req) {
  const { error } = await requireUser(req, { admin: true });
  if (error) return error;
  return NextResponse.json({ success: true, users: await listUsers() });
}

export async function POST(req) {
  const { user, error } = await requireUser(req, { admin: true });
  if (error) return error;
  await ensureSchema(mongoose.connection.db);

  const { email, password, scope } = await req.json().catch(() => ({}));
  const result = await createUser({
    email,
    password,
    // There is exactly one admin — the seeded account. Every user created
    // through this route is a viewer, whatever the request body claims, so no
    // crafted request can mint a second administrator.
    role: ROLES.VIEWER,
    scope,
    createdBy: user.email,
  });
  if (result.error) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  return NextResponse.json({ success: true, user: result.user }, { status: 201 });
}
