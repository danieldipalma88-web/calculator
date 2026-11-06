import { NextResponse } from "next/server";
import { calculatorReleaseVersion } from "../../../lib/calculator-release";

export const dynamic = "force-dynamic";

export async function GET() {
  const version = calculatorReleaseVersion();
  return NextResponse.json({ version }, {
    status: version ? 200 : 503,
    headers: { "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" },
  });
}
