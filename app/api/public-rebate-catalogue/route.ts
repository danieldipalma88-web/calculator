import { NextResponse } from "next/server";
import catalogue from "../../../lib/public-rebate-catalogue.generated.json";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(catalogue, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
