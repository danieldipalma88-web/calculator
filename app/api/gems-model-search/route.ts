import { NextRequest, NextResponse } from "next/server";
import {
  cleanGemsBrand,
  fetchGemsDatastoreRecords,
  fetchGemsMultiSplitRecords,
  isEligibleAustralianGemsRecord,
  isGemsMultiSplitOutdoorRecord,
  mapGemsModelSearchItem,
  normalizeGemsModelQuery,
} from "../../../lib/gems-model-search";

export const runtime = "nodejs";
export const maxDuration = 60;

const responseHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
};
// Keep the shared brand inventory cached, not individual search misses.
const modelSearchHeaders = { "Cache-Control": "no-store" };

const brandFields = ["Brand", "SubmitStatus", "Availability Status", "Sold_in"];
const modelFields = [
  "ApplStandard",
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

const multiBrandFields = [
  "ApplStandard",
  "Brand",
  "Configuration2",
  "SubmitStatus",
  "Availability Status",
  "Sold_in",
];

function displayBrand(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((part) =>
      /^[A-Z0-9&-]{2,3}$/.test(part)
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`,
    )
    .join(" ");
}

function distinctMappedModels(records: Record<string, unknown>[]) {
  const seen = new Set<string>();
  return records
    .filter(isEligibleAustralianGemsRecord)
    .filter(isGemsMultiSplitOutdoorRecord)
    .map(mapGemsModelSearchItem)
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => {
      const key = `${item.brand.toUpperCase()}|${normalizeGemsModelQuery(item.model)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function matchesModelQuery(model: string, rawQuery: string) {
  if (normalizeGemsModelQuery(model).includes(normalizeGemsModelQuery(rawQuery))) return true;
  const parts = (value: string) => value.split(/[\/\s,;+]+/).map(normalizeGemsModelQuery).filter(Boolean);
  const requested = parts(rawQuery);
  const registered = parts(model);
  // Accept either indoor/outdoor order, but only within the same registered pair.
  return requested.length === 2 && registered.length === 2 && (
    (registered[0].includes(requested[0]) && registered[1].includes(requested[1])) ||
    (registered[0].includes(requested[1]) && registered[1].includes(requested[0]))
  );
}

function matchingModels(records: Record<string, unknown>[], brand: string, rawQuery: string) {
  const query = normalizeGemsModelQuery(rawQuery);
  const seen = new Set<string>();
  return records
    .filter(isEligibleAustralianGemsRecord)
    .map(mapGemsModelSearchItem)
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => {
      if (normalizeGemsModelQuery(item.brand) !== normalizeGemsModelQuery(brand)) return false;
      if (!matchesModelQuery(item.model, rawQuery)) return false;
      const key = `${item.brand.toUpperCase()}|${normalizeGemsModelQuery(item.model)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const prefixDiff = Number(!normalizeGemsModelQuery(a.model).startsWith(query))
        - Number(!normalizeGemsModelQuery(b.model).startsWith(query));
      return prefixDiff || a.model.localeCompare(b.model);
    })
    .slice(0, 30);
}

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") || "models";
  try {
    if (mode === "multi-brands") {
      const records = await fetchGemsMultiSplitRecords({
        fields: multiBrandFields,
        limit: 10_000,
        revalidateSeconds: 86_400,
      });
      const grouped = new Map<string, string[]>();
      for (const record of records) {
        if (!isEligibleAustralianGemsRecord(record) || !isGemsMultiSplitOutdoorRecord(record)) continue;
        const raw = cleanGemsBrand(String(record.Brand || ""));
        if (!raw) continue;
        const key = raw.toLowerCase();
        const values = grouped.get(key) || [];
        values.push(raw);
        grouped.set(key, values);
      }
      const brands = [...grouped.values()]
        .map((values) => displayBrand(values[0]))
        .sort((a, b) => a.localeCompare(b));
      return NextResponse.json(
        { brands, count: brands.length },
        { headers: responseHeaders },
      );
    }

    if (mode === "multi-outdoors") {
      const brand = cleanGemsBrand(request.nextUrl.searchParams.get("brand") || "");
      if (!brand) {
        return NextResponse.json({ error: "Select a brand first." }, { status: 400 });
      }
      const records = await fetchGemsMultiSplitRecords({
        brand,
        fields: modelFields,
        limit: 10_000,
        revalidateSeconds: 3_600,
      });
      const models = distinctMappedModels(records).sort(
        (a, b) =>
          (a.capacityKw || 0) - (b.capacityKw || 0) ||
          a.model.localeCompare(b.model),
      );
      return NextResponse.json(
        { models, count: models.length },
        { headers: responseHeaders },
      );
    }

    if (mode === "brands") {
      const records = await fetchGemsDatastoreRecords({
        fields: brandFields,
        limit: 10_000,
        revalidateSeconds: 86_400,
      });
      const values = records.filter(isEligibleAustralianGemsRecord)
        .map((record) => cleanGemsBrand(String(record.Brand || ""))).filter(Boolean);
      const brands = [...new Map(values.map((brand) => [brand.toLowerCase(), displayBrand(brand)])).values()]
        .sort((a, b) => a.localeCompare(b));
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

    const inventoryOptions = {
      brand,
      fields: modelFields,
      limit: 10_000,
      revalidateSeconds: 3_600,
    };
    const records = await fetchGemsDatastoreRecords(inventoryOptions);
    let models = matchingModels(records, brand, rawQuery);
    if (!models.length) {
      const freshRecords = await fetchGemsDatastoreRecords({ ...inventoryOptions, revalidateSeconds: 0 });
      models = matchingModels(freshRecords, brand, rawQuery);
    }
    return NextResponse.json({ models }, { headers: modelSearchHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GEMS registry search failed";
    return NextResponse.json({ error: message }, { status: 503, headers: modelSearchHeaders });
  }
}
