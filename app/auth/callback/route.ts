import { NextResponse, type NextRequest } from "next/server";
import { publicSiteUrl } from "../../../lib/supabase/config";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function redirectBaseUrl(requestUrl: URL) {
  return requestUrl.origin || publicSiteUrl;
}

function safeNextPath(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/calculator";
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = safeNextPath(requestUrl.searchParams.get("next") || "/calculator");
  const baseUrl = redirectBaseUrl(requestUrl);

  if (!code) {
    const loginUrl = new URL("/", baseUrl);
    loginUrl.searchParams.set("error", "The login link did not return a login code. Please try again.");
    return NextResponse.redirect(loginUrl);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const loginUrl = new URL("/", baseUrl);
    loginUrl.searchParams.set("error", `Login failed: ${error.message}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.redirect(new URL(next, baseUrl));
}
