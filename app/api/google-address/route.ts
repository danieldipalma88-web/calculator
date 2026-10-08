import { NextResponse } from "next/server";
import { isOwnerEmail } from "../../../lib/admin";
import { publicSiteUrl } from "../../../lib/supabase/config";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type GoogleError = {
  status?: string;
  message?: string;
  details?: Array<{ reason?: string }>;
};

type GoogleAutocompleteResponse = {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
    };
  }>;
  error?: GoogleError;
};

type GooglePlaceDetailsResponse = {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  error?: GoogleError;
};

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function googleHeaders(fieldMask: string) {
  const serverKey = String(process.env.GOOGLE_PLACES_SERVER_KEY || "").trim();
  const key = serverKey || String(process.env.GOOGLE_MAPS_BROWSER_KEY || "").trim();
  if (!key) return null;
  const origin = new URL(publicSiteUrl).origin;
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": key,
    "X-Goog-FieldMask": fieldMask,
    ...(serverKey ? {} : { Origin: origin, Referer: `${origin}/` }),
  };
}

async function approvedEmail() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) return { status: 401 as const, email: "" };

  const upgradedApproval = await supabase
    .from("approved_users")
    .select("email, is_locked")
    .eq("email", email)
    .maybeSingle();
  const approval = upgradedApproval.error
    ? await supabase.from("approved_users").select("email").eq("email", email).maybeSingle()
    : upgradedApproval;
  if (approval.error) return { status: 503 as const, email: "" };
  if (Boolean((approval.data as { is_locked?: boolean } | null)?.is_locked)) {
    return { status: 403 as const, email: "" };
  }
  if (!approval.data && !isOwnerEmail(email)) return { status: 403 as const, email: "" };
  return { status: 200 as const, email };
}

function googleFailure(action: string, status: number, error?: GoogleError) {
  const reason = error?.details?.find((detail) => detail.reason)?.reason || "unknown";
  console.error("[google-address] Google Places request failed", {
    action,
    status,
    googleStatus: error?.status || "unknown",
    reason,
    message: (error?.message || "No error message returned").replace(/AIza[\w-]+/g, "[redacted]"),
  });
  if (status === 401 || status === 403) {
    return noStoreJson(
      { error: "Google address search is unavailable due to a service configuration issue. Please contact support." },
      503,
    );
  }
  return noStoreJson(
    { error: "Google address search is temporarily unavailable. Please try again." },
    502,
  );
}

async function googleRequest<T extends { error?: GoogleError }>(action: string, url: string, init: RequestInit) {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const result = (await response.json()) as T;
    return response.ok ? { result } : { failure: googleFailure(action, response.status, result.error) };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error("[google-address] Google Places request did not complete", { action, timedOut });
    return {
      failure: noStoreJson(
        { error: timedOut ? "Google address search took too long. Please try again." : "Google address search could not connect. Please try again." },
        timedOut ? 504 : 502,
      ),
    };
  }
}

export async function POST(request: Request) {
  const approval = await approvedEmail();
  if (approval.status !== 200) {
    const message = approval.status === 401 ? "Sign in to search for an address." : "Address search is unavailable.";
    return noStoreJson({ error: message }, approval.status);
  }

  const headers = googleHeaders("suggestions.placePrediction.placeId,suggestions.placePrediction.text");
  if (!headers) return noStoreJson({ error: "Google address search is not configured." }, 503);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action || "");
  const sessionToken = String(body?.sessionToken || "").trim().slice(0, 80);

  if (action === "autocomplete") {
    const input = String(body?.input || "").trim().slice(0, 180);
    if (input.length < 3) return noStoreJson({ suggestions: [] });

    const lookup = await googleRequest<GoogleAutocompleteResponse>(action, "https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input,
        includedRegionCodes: ["au"],
        languageCode: "en-AU",
        regionCode: "au",
        ...(sessionToken ? { sessionToken } : {}),
      }),
    });
    if (lookup.failure) return lookup.failure;
    const result = lookup.result;

    const suggestions = (result.suggestions || [])
      .map((suggestion) => ({
        placeId: String(suggestion.placePrediction?.placeId || "").trim(),
        text: String(suggestion.placePrediction?.text?.text || "").trim(),
      }))
      .filter((suggestion) => suggestion.placeId && suggestion.text)
      .slice(0, 8);
    return noStoreJson({ suggestions });
  }

  if (action === "details") {
    const placeId = String(body?.placeId || "").trim().slice(0, 300);
    if (!placeId) return noStoreJson({ error: "Choose a Google address first." }, 400);
    const detailHeaders = googleHeaders("id,formattedAddress,location");
    if (!detailHeaders) return noStoreJson({ error: "Google address search is not configured." }, 503);
    const query = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";
    const lookup = await googleRequest<GooglePlaceDetailsResponse>(action,
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${query}`,
      { headers: detailHeaders },
    );
    if (lookup.failure) return lookup.failure;
    const result = lookup.result;

    const formattedAddress = String(result.formattedAddress || "").trim();
    const verifiedPlaceId = String(result.id || "").trim();
    if (!formattedAddress || !verifiedPlaceId) {
      return noStoreJson({ error: "That Google result does not contain a complete address." }, 422);
    }
    return noStoreJson({
      place: {
        formattedAddress,
        placeId: verifiedPlaceId,
        latitude: Number.isFinite(result.location?.latitude) ? result.location?.latitude : null,
        longitude: Number.isFinite(result.location?.longitude) ? result.location?.longitude : null,
      },
    });
  }

  return noStoreJson({ error: "Unsupported address lookup action." }, 400);
}
