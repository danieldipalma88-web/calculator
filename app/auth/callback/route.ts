import { NextResponse, type NextRequest } from "next/server";
import { publicSiteUrl } from "../../../lib/supabase/config";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const OAUTH_NEXT_COOKIE = "calculatorOAuthNext";

function redirectBaseUrl(requestUrl: URL) {
  return requestUrl.origin || publicSiteUrl;
}

function safeNextPath(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/calculator";
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = safeNextPath(
    requestUrl.searchParams.get("next") ||
      request.cookies.get(OAUTH_NEXT_COOKIE)?.value ||
      "/calculator",
  );
  const baseUrl = redirectBaseUrl(requestUrl);

  function redirectWithoutOAuthState(url: URL) {
    const response = NextResponse.redirect(url);
    response.cookies.set(OAUTH_NEXT_COOKIE, "", {
      expires: new Date(0),
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      secure: url.protocol === "https:",
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  if (!code) {
    const loginUrl = new URL("/", baseUrl);
    loginUrl.searchParams.set("error", "The login link did not return a login code. Please try again.");
    return redirectWithoutOAuthState(loginUrl);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const loginUrl = new URL("/", baseUrl);
    loginUrl.searchParams.set("error", `Login failed: ${error.message}`);
    return redirectWithoutOAuthState(loginUrl);
  }

  return redirectWithoutOAuthState(new URL(next, baseUrl));
}
