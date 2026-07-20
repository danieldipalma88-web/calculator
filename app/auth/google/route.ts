import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const OAUTH_NEXT_COOKIE = "calculatorOAuthNext";

function safeNextPath(value: FormDataEntryValue | null) {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/calculator";
}

function loginUrl(request: NextRequest, message: string) {
  const url = new URL("/", request.nextUrl.origin);
  url.searchParams.set("error", message);
  return url;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const next = safeNextPath(formData.get("next"));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    return NextResponse.redirect(
      loginUrl(request, `Google login could not start: ${error?.message || "No authorization URL was returned."}`),
      303,
    );
  }

  const response = NextResponse.redirect(data.url, 303);
  response.cookies.set(OAUTH_NEXT_COOKIE, next, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/",
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
