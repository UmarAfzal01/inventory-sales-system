import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { COL } from "@/lib/schema";
import { requireUser } from "@/lib/guard";
import { setPassword, publicUser } from "@/lib/users";

export const runtime = "nodejs";

const oid = (id) => {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

/**
 * An admin must not disable, delete or demote themselves.
 *
 * With one admin account that is how a system ends up with nobody who can
 * administer it, and no way back in short of editing the database by hand.
 */
const isSelf = (actor, id) => String(actor._id) === String(id);

/** Disable, re-enable, change role, or reset a password. */
export async function PATCH(req, { params }) {
  const { user: actor, error } = await requireUser(req, { admin: true });
  if (error) return error;

  const { id } = await params;
  const _id = oid(id);
  if (!_id) return NextResponse.json({ success: false, error: "Unknown user." }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const update = {};

  if (typeof body.disabled === "boolean") {
    if (isSelf(actor, _id) && body.disabled) {
      return NextResponse.json(
        { success: false, error: "You cannot disable your own account." },
        { status: 400 }
      );
    }
    update.disabled = body.disabled;
  }

  if (body.role === "admin" || body.role === "viewer") {
    if (isSelf(actor, _id) && body.role !== "admin") {
      return NextResponse.json(
        { success: false, error: "You cannot remove your own admin access." },
        { status: 400 }
      );
    }
    update.role = body.role;
  }

  if (body.newPassword) {
    const result = await setPassword(_id, body.newPassword);
    if (result.error) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
  }

  if (Object.keys(update).length) {
    await mongoose.connection.db.collection(COL.USERS).updateOne({ _id }, { $set: update });
  }

  const fresh = await mongoose.connection.db.collection(COL.USERS).findOne({ _id });
  if (!fresh) return NextResponse.json({ success: false, error: "Unknown user." }, { status: 404 });
  return NextResponse.json({ success: true, user: publicUser(fresh) });
}

export async function DELETE(req, { params }) {
  const { user: actor, error } = await requireUser(req, { admin: true });
  if (error) return error;

  const { id } = await params;
  const _id = oid(id);
  if (!_id) return NextResponse.json({ success: false, error: "Unknown user." }, { status: 404 });
  if (isSelf(actor, _id)) {
    return NextResponse.json(
      { success: false, error: "You cannot delete your own account." },
      { status: 400 }
    );
  }

  // Refuses to remove the last admin, for the same reason as above.
  const target = await mongoose.connection.db.collection(COL.USERS).findOne({ _id });
  if (!target) return NextResponse.json({ success: false, error: "Unknown user." }, { status: 404 });
  if (target.role === "admin") {
    const admins = await mongoose.connection.db
      .collection(COL.USERS)
      .countDocuments({ role: "admin", disabled: { $ne: true } });
    if (admins <= 1) {
      return NextResponse.json(
        { success: false, error: "This is the only admin account — promote someone else first." },
        { status: 400 }
      );
    }
  }

  await mongoose.connection.db.collection(COL.USERS).deleteOne({ _id });
  return NextResponse.json({ success: true });
}
