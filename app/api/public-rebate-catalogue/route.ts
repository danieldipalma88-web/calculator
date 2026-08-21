import { NextResponse } from "next/server";
import { buildPublicRebateCatalogue } from "../../../lib/public-rebate-catalogue";

export const runtime = "nodejs";

export async function GET() {
  try {
    const catalogue = await buildPublicRebateCatalogue();
    return NextResponse.json(catalogue, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "The public rebate catalogue is temporarily unavailable." }, { status: 503 });
  }
}
