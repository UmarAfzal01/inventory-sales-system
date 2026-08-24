import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { username, password } = await req.json();

    const validUsername = process.env.ADMIN_USERNAME || "admin";
    const validPassword = process.env.ADMIN_PASSWORD || "password";

    if (username === validUsername && password === validPassword) {
      const response = NextResponse.json({ success: true, message: "Logged in successfully" });
      
      // Set a secure HTTP-only session cookie lasting 7 days
      response.cookies.set({
        name: "auth_token",
        value: "authenticated_session_active",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 7, 
      });

      return response;
    }

    return NextResponse.json({ success: false, error: "Invalid username or password" }, { status: 401 });
  } catch (err) {
    return NextResponse.json({ success: false, error: "Server authentication error" }, { status: 500 });
  }
}