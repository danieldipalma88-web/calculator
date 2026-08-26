import { NextRequest, NextResponse } from "next/server";
import {
  cleanGemsBrand,
  fetchGemsDatastoreRecords,
  isEligibleAustralianGemsRecord,
  mapGemsModelSearchItem,
  normalizeGemsModelQuery,
} from "../../../lib/gems-model-search";

export const runtime = "nodejs";

const responseHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
};

const brandFields = ["Brand", "SubmitStatus", "Availability Status", "Sold_in"];
const modelFields = [
  "Brand",
  "Model_No",
  "Family Name",
  "Configuration1",
  "Configuration2",
  "Product Class",
  "C-Total Cool Rated",
  "H-Total Heat Rated",
  "C-Power_Inp_Rated",
  "Rated AEER",
  "Rated ACOP",
  "Residential TCSPF_mixed",
  "Residential HSPF_mixed",
  "Residential HSPF_cold",
  "Residential tcec_hot",
  "Residential tcec_mixed",
  "Residential tcec_cold",
  "Residential thec_hot",
  "Residential thec_mixed",
  "Residential thec_cold",
  "Outdoor unit only",
  "Phase",
  "SubmitStatus",
  "Availability Status",
  "Sold_in",
];

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") || "models";
  try {
    if (mode === "brands") {
      const records = await fetchGemsDatastoreRecords({
        fields: brandFields,
        limit: 10_000,
        revalidateSeconds: 86_400,
      });
      const brands = [
        ...new Set(
          records
            .filter(isEligibleAustralianGemsRecord)
            .map((record) => cleanGemsBrand(String(record.Brand || "")))
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b));
      return NextResponse.json({ brands }, { headers: responseHeaders });
    }

    const brand = cleanGemsBrand(request.nextUrl.searchParams.get("brand") || "");
    const rawQuery = request.nextUrl.searchParams.get("q") || "";
    const query = normalizeGemsModelQuery(rawQuery);
    if (!brand) {
      return NextResponse.json({ error: "Select a brand first." }, { status: 400 });
    }
    if (query.length < 2) {
      return NextResponse.json(
        { error: "Enter at least two model characters." },
        { status: 400 },
      );
    }

    const records = await fetchGemsDatastoreRecords({
      brand,
      fields: modelFields,
      limit: 10_000,
      revalidateSeconds: 3_600,
    });
    const seen = new Set<string>();
    const models = records
      .filter(isEligibleAustralianGemsRecord)
      .map(mapGemsModelSearchItem)
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .filter((item) => {
        if (!normalizeGemsModelQuery(item.model).includes(query)) return false;
        const key = `${item.brand.toUpperCase()}|${item.model
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const aModel = normalizeGemsModelQuery(a.model);
        const bModel = normalizeGemsModelQuery(b.model);
        const prefixDiff = Number(!aModel.startsWith(query)) - Number(!bModel.startsWith(query));
        return prefixDiff || a.model.localeCompare(b.model);
      })
      .slice(0, 30);

    return NextResponse.json({ models }, { headers: responseHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GEMS registry search failed";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
