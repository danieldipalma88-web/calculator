import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "./config";
import { temporaryAuthFailure, withCalculatorAuthDeadline } from "./calculator-entry";

type CookieToSet = {
  name: string;
  value: string;
  options?: Parameters<NextResponse["cookies"]["set"]>[2];
};

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  if (!supabaseUrl || !supabasePublishableKey) {
    return response;
  }

  const makeClient = (authFetch?: typeof fetch, signal?: AbortSignal) =>
    createServerClient(supabaseUrl!, supabasePublishableKey!, {
    ...(authFetch ? { global: { fetch: authFetch } } : {}),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        if (signal?.aborted) return;
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  if (request.nextUrl.pathname === "/calculator") {
    try {
      // Only rotate expiring cookies here. The page independently verifies the user.
      const { error } = await withCalculatorAuthDeadline((signal, authFetch) =>
        makeClient(authFetch, signal).auth.getSession(),
      );
      if (temporaryAuthFailure(error)) throw error;
    } catch (error) {
      if (!temporaryAuthFailure(error)) throw error;
      return new NextResponse(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Calculator sign-in</title><main><h1>Sign-in is taking longer than usual</h1><p>Please try opening the calculator again.</p><a href="">Try again</a></main></html>',
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "Retry-After": "5" } },
      );
    }
  } else {
    await makeClient().auth.getUser();
  }
  return response;
}
