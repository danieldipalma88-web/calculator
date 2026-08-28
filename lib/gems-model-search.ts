const GEMS_DATASTORE_API =
  "https://data.gov.au/data/api/3/action/datastore_search";
const GEMS_DATASTORE_SQL_API =
  "https://data.gov.au/data/api/3/action/datastore_search_sql";

export const GEMS_AIRCON_RESOURCE_IDS = [
  "0973a476-eb0c-45e6-9a18-054f74307843",
  "d4e17a35-9002-4a0c-ac1c-003ece0de135",
] as const;

const REQUIRED_SEARCH_FIELDS = [
  "Cooling Capacity",
  "Heating Capacity",
  "Input Power",
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
] as const;

export type GemsSearchRecord = Record<string, unknown>;

export type GemsModelSearchItem = {
  brand: string;
  model: string;
  family: string;
  productType: string;
  productClass: string;
  capacityKw: number | null;
  phase: string;
  outdoorOnly: boolean;
  multiHead: boolean;
  multiSplitOutdoor: boolean;
  completeEnergyData: boolean;
  metadata: Record<string, unknown>;
};

function recordValue(record: GemsSearchRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return value;
    }
  }
  return "";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeGemsModelQuery(value: string) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 80);
}

export function gemsDatastoreSearchQuery(value: string) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 160);
}

export function cleanGemsBrand(value: string) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 100);
}

export function isEligibleAustralianGemsRecord(record: GemsSearchRecord) {
  const submitStatus = String(recordValue(record, ["SubmitStatus"])).toLowerCase();
  const availability = String(
    recordValue(record, ["Availability Status"]),
  ).toLowerCase();
  const soldIn = String(recordValue(record, ["Sold_in", "Sold in"])).toLowerCase();
  return (
    submitStatus === "approved" &&
    availability === "available" &&
    soldIn.includes("australia")
  );
}

export function isGemsMultiSplitOutdoorRecord(record: GemsSearchRecord) {
  const applicationStandard = String(
    recordValue(record, ["ApplStandard", "Application Standard"]),
  );
  const configuration = String(recordValue(record, ["Configuration2"]));
  return (
    /multi[ -]?split/i.test(applicationStandard) &&
    /^(fixed|vrf)$/i.test(configuration.trim())
  );
}

export function mapGemsModelSearchItem(
  record: GemsSearchRecord,
): GemsModelSearchItem | null {
  const brand = String(recordValue(record, ["Brand", "Brand Name", "brand"])).trim();
  const model = String(
    recordValue(record, ["Model_No", "Model No", "Model Number", "model"]),
  ).trim();
  if (!brand || !model) return null;

  const family = String(recordValue(record, ["Family Name", "Family_Name"])).trim();
  const productType = String(
    recordValue(record, ["Configuration1", "Product Type"]),
  ).trim();
  const configuration = String(recordValue(record, ["Configuration2"])).trim();
  const productClass = String(
    recordValue(record, ["Product Class", "Product_Class", "ProductClass"]),
  ).trim();
  const capacityKw = numberValue(
    recordValue(record, ["C-Total Cool Rated", "Cooling Capacity"]),
  );
  const phaseText = String(
    recordValue(record, ["Phase", "Power Phase", "Power supply phase"]),
  ).trim();
  const outdoorOnlyText = String(
    recordValue(record, ["Outdoor unit only", "Outdoor Unit Only"]),
  ).trim();
  const combinedType = `${productType} ${configuration} ${family}`.toLowerCase();
  const outdoorOnly = /^(yes|true|1)$/i.test(outdoorOnlyText);
  const multiSplitOutdoor =
    isGemsMultiSplitOutdoorRecord(record) || /multi[ -]?(split|head)/i.test(combinedType);
  const multiHead = multiSplitOutdoor;
  const mappedEnergyValues: Record<string, unknown> = {
    "Cooling Capacity": recordValue(record, ["C-Total Cool Rated", "Cooling Capacity"]),
    "Heating Capacity": recordValue(record, ["H-Total Heat Rated", "Heating Capacity"]),
    "Input Power": recordValue(record, [
      "C-Power_Inp_Rated",
      "Input Power",
      "Rated cooling power input kW",
    ]),
    "Rated AEER": recordValue(record, ["Rated AEER"]),
    "Rated ACOP": recordValue(record, ["Rated ACOP"]),
    "Residential TCSPF_mixed": recordValue(record, ["Residential TCSPF_mixed"]),
    "Residential HSPF_mixed": recordValue(record, ["Residential HSPF_mixed"]),
    "Residential HSPF_cold": recordValue(record, ["Residential HSPF_cold"]),
    "Residential tcec_hot": recordValue(record, ["Residential tcec_hot"]),
    "Residential tcec_mixed": recordValue(record, ["Residential tcec_mixed"]),
    "Residential tcec_cold": recordValue(record, ["Residential tcec_cold"]),
    "Residential thec_hot": recordValue(record, ["Residential thec_hot"]),
    "Residential thec_mixed": recordValue(record, ["Residential thec_mixed"]),
    "Residential thec_cold": recordValue(record, ["Residential thec_cold"]),
  };
  const completeEnergyData = REQUIRED_SEARCH_FIELDS.every(
    (field) => numberValue(mappedEnergyValues[field]) !== null,
  );
  const metadata = {
    brand,
    model,
    "Product Type": productType,
    "Product Class": productClass,
    Configuration2: configuration,
    ApplStandard: recordValue(record, ["ApplStandard", "Application Standard"]),
    Phase: phaseText,
    ...mappedEnergyValues,
  };

  return {
    brand,
    model,
    family,
    productType,
    productClass,
    capacityKw,
    phase: phaseText,
    outdoorOnly,
    multiHead,
    multiSplitOutdoor,
    completeEnergyData,
    metadata,
  };
}

function safeSqlFields(fields: string[]) {
  return fields.map((field) => {
    if (!/^[A-Za-z0-9 _-]+$/.test(field)) {
      throw new Error(`Unsupported GEMS field: ${field}`);
    }
    return `"${field}"`;
  });
}

function sqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

export async function fetchGemsMultiSplitRecords(options: {
  brand?: string;
  fields: string[];
  limit?: number;
  revalidateSeconds: number;
}) {
  const fields = safeSqlFields(options.fields);
  const limit = Math.min(Math.max(Math.floor(options.limit || 10_000), 1), 10_000);
  const brand = cleanGemsBrand(options.brand || "");
  let lastError: unknown = null;

  for (const resourceId of GEMS_AIRCON_RESOURCE_IDS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const clauses = [
        `"SubmitStatus" = 'Approved'`,
        `"Availability Status" = 'Available'`,
        `LOWER("Sold_in") LIKE '%australia%'`,
        `LOWER("Configuration2") IN ('fixed', 'vrf')`,
        `LOWER("ApplStandard") LIKE '%multi-split%'`,
      ];
      if (brand) clauses.push(`LOWER("Brand") = LOWER('${sqlLiteral(brand)}')`);
      const sql = `SELECT ${fields.join(", ")} FROM "${resourceId}" WHERE ${clauses.join(" AND ")} LIMIT ${limit}`;
      const response = await fetch(
        `${GEMS_DATASTORE_SQL_API}?sql=${encodeURIComponent(sql)}`,
        {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "RebatePortalCalculator/1.0",
          },
          next: { revalidate: options.revalidateSeconds },
        },
      );
      if (!response.ok) throw new Error(`GEMS registry returned HTTP ${response.status}`);
      const payload = await response.json();
      const records = payload?.result?.records;
      if (!payload?.success || !Array.isArray(records)) {
        throw new Error("GEMS registry returned an invalid response");
      }
      return records as GemsSearchRecord[];
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new Error("GEMS registry search timed out");
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("GEMS registry search is unavailable");
}

export async function fetchGemsDatastoreRecords(options: {
  brand?: string;
  query?: string;
  fields?: string[];
  limit?: number;
  revalidateSeconds: number;
}) {
  let lastError: unknown = null;
  for (const resourceId of GEMS_AIRCON_RESOURCE_IDS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const params = new URLSearchParams({
        resource_id: resourceId,
        limit: String(Math.min(Math.max(Math.floor(options.limit || 1000), 1), 10_000)),
      });
      const brand = cleanGemsBrand(options.brand || "");
      // CKAN searches registered paired models by their original punctuation.
      // Compact normalization is only appropriate when comparing returned rows.
      const query = gemsDatastoreSearchQuery(options.query || "");
      if (brand) {
        params.set(
          "filters",
          JSON.stringify({
            Brand: brand,
            SubmitStatus: "Approved",
            "Availability Status": "Available",
          }),
        );
      }
      if (query) params.set("q", query);
      if (options.fields?.length) params.set("fields", options.fields.join(","));
      const response = await fetch(`${GEMS_DATASTORE_API}?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "RebatePortalCalculator/1.0",
        },
        next: { revalidate: options.revalidateSeconds },
      });
      if (!response.ok) throw new Error(`GEMS registry returned HTTP ${response.status}`);
      const payload = await response.json();
      const records = payload?.result?.records;
      if (!payload?.success || !Array.isArray(records)) {
        throw new Error("GEMS registry returned an invalid response");
      }
      return records as GemsSearchRecord[];
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new Error("GEMS registry search timed out");
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("GEMS registry search is unavailable");
}
