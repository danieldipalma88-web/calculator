import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { createGemsCalculationMetadata, GEMS_INVENTORY_REVALIDATE_SECONDS, GemsCalculationMetadataError } from "../../../lib/gems-calculation-metadata";

export const runtime = "nodejs";
export const maxDuration = 12;

const lookup = createGemsCalculationMetadata({
  wrapInventory: load => unstable_cache(load, ["gems-calculation-inventory-v3"], { revalidate: GEMS_INVENTORY_REVALIDATE_SECONDS }),
});

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const params = new URL(request.url).searchParams;
  try {
    if (params.getAll("brand").length !== 1 || params.getAll("model").length !== 1) throw new GemsCalculationMetadataError("GEMS_INVALID_REQUEST");
    return NextResponse.json(await lookup(params.get("brand"), params.get("model")), { headers });
  } catch (error) {
    const failure = error instanceof GemsCalculationMetadataError ? error : new GemsCalculationMetadataError("GEMS_UNAVAILABLE");
    return NextResponse.json({ code: failure.code, error: failure.message }, {
      status: failure.status,
      headers: failure.status === 503 ? { ...headers, "Retry-After": "5" } : headers,
    });
  }
}
