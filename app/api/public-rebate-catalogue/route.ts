import { NextResponse } from "next/server";
import catalogue from "../../../lib/public-rebate-catalogue.generated.json";
import { mergedPublicCatalogue, readAddedModels } from "../../../lib/model-catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let current = catalogue;
  try { current = mergedPublicCatalogue(await readAddedModels()) as typeof catalogue; }
  catch { console.error("Verified catalogue additions unavailable; serving built-in catalogue"); }
  return NextResponse.json(current, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
