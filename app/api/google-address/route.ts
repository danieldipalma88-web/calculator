import { NextResponse } from "next/server";
import { isOwnerEmail } from "../../../lib/admin";
import { publicSiteUrl } from "../../../lib/supabase/config";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type GoogleAutocompleteResponse = {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
    };
  }>;
  error?: { status?: string; message?: string };
};

type GooglePlaceDetailsResponse = {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  error?: { status?: string; message?: string };
};

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function googleHeaders(fieldMask: string) {
  const key = String(process.env.GOOGLE_MAPS_BROWSER_KEY || "").trim();
  if (!key) return null;
  const origin = new URL(publicSiteUrl).origin;
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": key,
    "X-Goog-FieldMask": fieldMask,
    Origin: origin,
    Referer: `${origin}/`,
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

function googleFailure(action: string, status: number, error?: { status?: string; message?: string }) {
  console.error("[google-address] Google Places request failed", {
    action,
    status,
    googleStatus: error?.status || "unknown",
    message: error?.message || "No error message returned",
  });
  return noStoreJson(
    { error: "Google address search is temporarily unavailable. Please try again." },
    502,
  );
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

    const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input,
        includedRegionCodes: ["au"],
        languageCode: "en-AU",
        regionCode: "au",
        ...(sessionToken ? { sessionToken } : {}),
      }),
      cache: "no-store",
    });
    const result = (await response.json().catch(() => ({}))) as GoogleAutocompleteResponse;
    if (!response.ok) return googleFailure(action, response.status, result.error);

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
    const response = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${query}`,
      { headers: detailHeaders, cache: "no-store" },
    );
    const result = (await response.json().catch(() => ({}))) as GooglePlaceDetailsResponse;
    if (!response.ok) return googleFailure(action, response.status, result.error);

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
