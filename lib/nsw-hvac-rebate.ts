import catalogueData from "./public-rebate-catalogue.generated.json";
import {
  fetchGemsDatastoreRecords,
  isEligibleAustralianGemsRecord,
  mapGemsModelSearchItem,
  type GemsModelSearchItem,
} from "./gems-model-search";
import {
  DCCEEW_CONTRACT_RATE,
  DCCEEW_ELIGIBLE_POSTCODES,
  DCCEEW_ELIGIBLE_PRODUCT_KEYS,
} from "./dcceew-contract-data";

const ESS_ESTIMATOR_API = "https://estimator-sfg-rac-prd.energy.nsw.gov.au";
const ESS_CALCULATE_API = "https://of-sfg-rac-prd.energy.nsw.gov.au/calculate";
const ESS_CALC_DATE = "2021-01-01";
const FETCH_TIMEOUT_MS = 12_000;

type RebateSystemType = "split" | "ducted" | "multi_split";
type InstallType = "new" | "replacement";
type ClimateZone = "hot" | "mixed" | "cold";
type Metadata = Record<string, unknown>;

type CatalogueProduct = {
  brand: string;
  model: string;
  modelAliases?: string[];
  searchTerms?: string[];
  dcceewEligible?: boolean;
};

type LocalFallbackRow = {
  brand?: string;
  model?: string;
  type?: string;
  productClass?: string;
  cooling?: number;
  heating?: number;
  input?: number;
  aeer?: number;
  acop?: number;
  tcspfCold?: number;
  tcspfMixed?: number;
  tcspfHot?: number;
  hspfCold?: number;
  hspfMixed?: number;
  hspfHot?: number;
  tcecCold?: number;
  tcecMixed?: number;
  tcecHot?: number;
  thecCold?: number;
  thecMixed?: number;
  thecHot?: number;
};

export type SavedMultiHeadRating = {
  model: string;
  qty: number;
  ratedCoolingCapacity: number;
  ratedHeatingCapacity: number;
};

export type CurrentRebateInput = {
  brand: string;
  model: string;
  postcode: string;
  installType: InstallType;
  systemType: RebateSystemType;
  escRate: number;
  prcRate: number;
  indoorHeads?: SavedMultiHeadRating[];
};

export type CurrentRebateResult = {
  rebate: number;
  esc: number;
  prc: number;
  escRate: number;
  prcRate: number;
  contractApplied: boolean;
  lookupSource: string;
};

const catalogue = catalogueData as {
  products: CatalogueProduct[];
  fallbackMetadata: LocalFallbackRow[];
};
const dcceewPostcodes = new Set<number>(DCCEEW_ELIGIBLE_POSTCODES);
const dcceewProductKeys = new Set<string>(DCCEEW_ELIGIBLE_PRODUCT_KEYS);
const metadataCache = new Map<string, Promise<{ meta: Metadata; source: string }>>();
const climateCache = new Map<string, Promise<{ postcode: string; climateZone: ClimateZone; bcaZone: string }>>();

const AIR_CONDITIONER_TYPES = [
  "non_ducted_single_split_system",
  "ducted_single_split_system",
  "non_ducted_multi_split_system",
] as const;

const ELIGIBLE_PRODUCT_CLASSES = new Set([5, 6, 7, 8, 9, 10, 11, 12, 18, 19, 20, 21]);
const EFFICIENCY_REQUIREMENTS = [
  { classes: [8, 18], tcspfMixed: 5.5, hspfMixed: 4.5, hspfCold: 4.0, aeer: 4.3, acop: 4.4 },
  { classes: [9, 19], tcspfMixed: 4.5, hspfMixed: 4.0, hspfCold: 3.5, aeer: 3.6, acop: 3.8 },
  { classes: [10, 11, 20], tcspfMixed: 4.0, hspfMixed: 3.5, hspfCold: 3.0, aeer: 3.5, acop: 3.8 },
  { classes: [5, 6, 7, 12, 21], tcspfMixed: 3.0, hspfMixed: 2.5, hspfCold: 2.0, aeer: 3.3, acop: 3.5 },
];

const CERTIFICATE_OUTPUT_FIELDS = [
  "HVAC1_PDRSAug24_electricity_savings",
  "HVAC1_PDRSAug24_PDRS__regional_network_factor",
  "HVAC1_PDRSAug24_peak_demand_reduction_capacity",
  "HVAC1_PDRSAug24_get_network_loss_factor_by_postcode",
  "HVAC1_PDRSAug24_ESC_calculation",
  "HVAC1_PDRSAug24_PRC_calculation",
  "HVAC1_PDRSAug24_annual_energy_savings",
  "HVAC1_PDRSAug24_peak_demand_annual_savings",
];
const CERTIFICATE_ESC_PROXY_FIELDS = [
  "HVAC1_PDRSAug24_electricity_savings",
  "HVAC1_PDRSAug24_annual_energy_savings",
];
const CERTIFICATE_ACTUAL_POSTCODE_FIELDS = [
  "HVAC1_PDRSAug24_PDRS__regional_network_factor",
  "HVAC1_PDRSAug24_peak_demand_reduction_capacity",
  "HVAC1_PDRSAug24_get_network_loss_factor_by_postcode",
  "HVAC1_PDRSAug24_PRC_calculation",
  "HVAC1_PDRSAug24_peak_demand_annual_savings",
];

function normalize(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function normalizeBrand(value: unknown) {
  const compact = normalize(value);
  if (compact === "ACTRON" || compact === "ACTRONAIR") return "ACTRONAIR";
  if (compact === "FUJITSU" || compact === "FUJITSUGENERAL") return "FUJITSU";
  if (compact === "MITSUBISHIHI" || compact === "MITSUBISHIHEAVYINDUSTRIES") return "MITSUBISHIHEAVYINDUSTRIES";
  return compact;
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Live rebate service unavailable");
}

async function fetchJson(url: string, options: RequestInit & { next?: { revalidate: number } } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? ` - ${body.slice(0, 300)}` : ""}`);
    }
    return await response.json() as unknown;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Live rebate service timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function catalogueProductFor(brand: string, model: string) {
  const brandKey = normalizeBrand(brand);
  const modelKey = normalize(model);
  const exactBrand = catalogue.products.find((product) =>
    normalizeBrand(product.brand) === brandKey
      && [product.model, ...(product.modelAliases || [])].some((candidate) => normalize(candidate) === modelKey),
  );
  return exactBrand || catalogue.products.find((product) =>
    [product.model, ...(product.modelAliases || [])].some((candidate) => normalize(candidate) === modelKey),
  ) || null;
}

function modelCandidates(brand: string, model: string) {
  const product = catalogueProductFor(brand, model);
  const candidates = [model, product?.model, ...(product?.modelAliases || []), ...(product?.searchTerms || [])]
    .flatMap((candidate) => {
      const value = String(candidate || "").trim();
      return [value, ...value.split(/[\/|]+/).map((part) => part.trim())];
    })
    .filter((candidate) => normalize(candidate).length >= 5);
  return [...new Set(candidates)];
}

function fallbackMetadata(row: LocalFallbackRow): Metadata {
  return {
    brand: row.brand,
    model: row.model,
    "Product Type": row.type,
    "Product Class": row.productClass || "",
    "Cooling Capacity": row.cooling,
    "Heating Capacity": row.heating,
    "Input Power": row.input,
    "Rated AEER": row.aeer,
    "Rated ACOP": row.acop,
    "Residential TCSPF_cold": row.tcspfCold,
    "Residential TCSPF_mixed": row.tcspfMixed,
    "Residential TCSPF_hot": row.tcspfHot,
    "Residential HSPF_cold": row.hspfCold,
    "Residential HSPF_mixed": row.hspfMixed,
    "Residential HSPF_hot": row.hspfHot,
    "Residential tcec_cold": row.tcecCold,
    "Residential tcec_mixed": row.tcecMixed,
    "Residential tcec_hot": row.tcecHot,
    "Residential thec_cold": row.thecCold,
    "Residential thec_mixed": row.thecMixed,
    "Residential thec_hot": row.thecHot,
  };
}

function localMetadataFor(brand: string, model: string) {
  const brandKeys = new Set([normalizeBrand(brand), normalizeBrand(catalogueProductFor(brand, model)?.brand)]);
  const modelKeys = new Set(modelCandidates(brand, model).map(normalize));
  const row = catalogue.fallbackMetadata.find((candidate) =>
    brandKeys.has(normalizeBrand(candidate.brand)) && modelKeys.has(normalize(candidate.model)),
  );
  return row ? fallbackMetadata(row) : null;
}

function completeMetadata(meta: Metadata) {
  return [
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
  ].every((field) => Number.isFinite(finiteNumber(meta[field])));
}

function bestGemsItem(items: GemsModelSearchItem[], brand: string, candidates: string[]) {
  const brandKey = normalizeBrand(brand);
  const candidateKeys = new Set(candidates.map(normalize));
  return items.find((item) =>
    item.completeEnergyData
      && normalizeBrand(item.brand) === brandKey
      && candidateKeys.has(normalize(item.model)),
  ) || items.find((item) => item.completeEnergyData && candidateKeys.has(normalize(item.model))) || null;
}

async function fetchGemsMetadata(brand: string, candidates: string[]) {
  const records: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const found = await fetchGemsDatastoreRecords({
      query: candidate,
      limit: 250,
      revalidateSeconds: 3_600,
    }).catch(() => []);
    records.push(...found);
    const item = bestGemsItem(
      records.filter(isEligibleAustralianGemsRecord).map(mapGemsModelSearchItem).filter(Boolean) as GemsModelSearchItem[],
      brand,
      candidates,
    );
    if (item) return item.metadata;
  }
  throw new Error(`Model not found in the current GEMS registry: ${candidates[0] || "unknown model"}`);
}

function apiArray(value: unknown) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { value?: unknown }).value)) {
    return (value as { value: unknown[] }).value;
  }
  return [];
}

function apiModelValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["model", "model_number", "modelNumber", "name", "value", "label", "text", "display_name", "displayName"]) {
    if (record[key]) return String(record[key]);
  }
  return "";
}

async function fetchNswEstimatorMetadata(brand: string, candidates: string[]) {
  const rawBrands = apiArray(await fetchJson(`${ESS_ESTIMATOR_API}/commercial_hvac/brands`, {
    next: { revalidate: 86_400 },
  }));
  const wantedBrands = new Set([normalizeBrand(brand), normalizeBrand(catalogueProductFor(brand, candidates[0])?.brand)]);
  const brands = rawBrands.map(String).filter((candidate) => wantedBrands.has(normalizeBrand(candidate)));
  for (const apiBrand of brands) {
    const rawModels = apiArray(await fetchJson(
      `${ESS_ESTIMATOR_API}/commercial_hvac/brands/${encodeURIComponent(apiBrand)}/models`,
      { next: { revalidate: 3_600 } },
    ));
    const candidateKeys = new Set(candidates.map(normalize));
    const apiModel = rawModels.find((candidate) => candidateKeys.has(normalize(apiModelValue(candidate))));
    if (!apiModel) continue;
    const apiModelText = apiModelValue(apiModel);
    const metadata = await fetchJson(`${ESS_ESTIMATOR_API}/commercial_hvac/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand: apiBrand, model: apiModelText }),
      next: { revalidate: 3_600 },
    });
    if (metadata && typeof metadata === "object" && completeMetadata(metadata as Metadata)) return metadata as Metadata;
  }
  throw new Error(`Model not found in the NSW estimator metadata: ${candidates[0] || "unknown model"}`);
}

async function resolveMetadata(brand: string, model: string) {
  const cacheKey = `${normalizeBrand(brand)}|${normalize(model)}`;
  const existing = metadataCache.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    const local = localMetadataFor(brand, model);
    if (local && normalizeBrand(brand) === "ACTRONAIR") {
      return { meta: local, source: "Verified GEMS metadata + NSW formula" };
    }
    const candidates = modelCandidates(brand, model);
    try {
      return { meta: await fetchGemsMetadata(brand, candidates), source: "GEMS registry + NSW formula" };
    } catch (gemsError) {
      try {
        return { meta: await fetchNswEstimatorMetadata(brand, candidates), source: "NSW estimator metadata + NSW formula" };
      } catch {
        if (local) return { meta: local, source: "Saved GEMS fallback + NSW formula" };
        throw gemsError;
      }
    }
  })();
  metadataCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    metadataCache.delete(cacheKey);
    throw error;
  }
}

function normalizeClimateZone(value: unknown): ClimateZone | "" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "hot" || normalized === "mixed" || normalized === "cold") return normalized;
  if (normalized === "average") return "mixed";
  return "";
}

function fallbackClimateZone(postcode: string): ClimateZone | "" {
  const number = Number(postcode);
  return Number.isInteger(number) && ((number >= 2555 && number <= 2560) || (number >= 2563 && number <= 2574))
    ? "mixed"
    : "";
}

async function resolveClimate(postcode: string) {
  const existing = climateCache.get(postcode);
  if (existing) return existing;
  const promise = (async () => {
    const payload = {
      buildings: { building_1: {
        HVAC1_PDRSAug24_PDRS__postcode: { [ESS_CALC_DATE]: postcode },
        HVAC1_PDRSAug24_get_climate_zone_by_postcode: { [ESS_CALC_DATE]: null },
        HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { [ESS_CALC_DATE]: null },
      } },
      persons: { person1: {} },
    };
    const response = await fetchJson(ESS_CALCULATE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }) as { buildings?: { building_1?: Record<string, Record<string, unknown>> } };
    const building = response.buildings?.building_1 || {};
    const climateZone = normalizeClimateZone(building.HVAC1_PDRSAug24_get_climate_zone_by_postcode?.[ESS_CALC_DATE])
      || fallbackClimateZone(postcode);
    const rawBca = Number(building.HVAC1_PDRSAug24_BCA_climate_zone_by_postcode?.[ESS_CALC_DATE]);
    const bcaNumber = postcode === "2163" ? 5 : rawBca;
    const bcaZone = Number.isInteger(bcaNumber) && bcaNumber >= 1 && bcaNumber <= 8
      ? `BCA_Climate_Zone_${bcaNumber}`
      : "";
    if (!climateZone || !bcaZone) throw new Error(`Unable to resolve climate zones for postcode ${postcode}`);
    return { postcode, climateZone, bcaZone };
  })();
  climateCache.set(postcode, promise);
  try {
    return await promise;
  } catch (error) {
    climateCache.delete(postcode);
    throw error;
  }
}

function productClassNumber(value: unknown) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : Number.NaN;
}

function deriveProductClass(meta: Metadata, systemType: RebateSystemType) {
  const direct = productClassNumber(meta["Product Class"]);
  if (ELIGIBLE_PRODUCT_CLASSES.has(direct)) return `Class ${direct}`;
  const cooling = finiteNumber(meta["Cooling Capacity"]);
  if (!(cooling > 0)) return "";
  const type = `${meta["Product Type"] || ""} ${meta.Configuration1 || ""}`.toLowerCase();
  const configuration = String(meta.Configuration2 || "").toLowerCase();
  const unitary = configuration.includes("unitary");
  if (unitary) return cooling < 10 ? "Class 18" : cooling < 25 ? "Class 19" : cooling <= 65 ? "Class 20" : "";
  const ducted = (type.includes("ducted") && !type.includes("non")) || systemType === "ducted";
  if (ducted) return cooling < 10 ? "Class 10" : cooling < 25 ? "Class 11" : cooling <= 65 ? "Class 12" : "";
  if (systemType === "split" || systemType === "multi_split" || type.includes("non")) {
    return cooling < 4 ? "Class 8" : cooling < 10 ? "Class 9" : "";
  }
  return "";
}

function passesMetric(meta: Metadata, primary: string, primaryMinimum: number, fallback: string, fallbackMinimum: number) {
  const primaryValue = finiteNumber(meta[primary]);
  if (primaryValue > 0) return primaryValue >= primaryMinimum;
  const fallbackValue = finiteNumber(meta[fallback]);
  return fallbackValue > 0 && fallbackValue >= fallbackMinimum;
}

function eligibility(meta: Metadata, climateZone: ClimateZone, systemType: RebateSystemType) {
  const productClass = deriveProductClass(meta, systemType);
  const classNumber = productClassNumber(productClass);
  const requirement = EFFICIENCY_REQUIREMENTS.find((row) => row.classes.includes(classNumber));
  if (!productClass || !ELIGIBLE_PRODUCT_CLASSES.has(classNumber) || !requirement) {
    return { productClass, escEligible: false, prcEligible: false };
  }
  let escEligible = true;
  let prcEligible = true;
  const cooling = finiteNumber(meta["Cooling Capacity"]);
  if (cooling > 0 && !passesMetric(meta, "Residential TCSPF_mixed", requirement.tcspfMixed, "Rated AEER", requirement.aeer)) {
    escEligible = false;
    prcEligible = false;
  }
  const heating = finiteNumber(meta["Heating Capacity"]);
  const heatField = climateZone === "cold" ? "Residential HSPF_cold" : "Residential HSPF_mixed";
  const heatMinimum = climateZone === "cold" ? requirement.hspfCold : requirement.hspfMixed;
  if (heating > 0 && !passesMetric(meta, heatField, heatMinimum, "Rated ACOP", requirement.acop)) escEligible = false;
  return { productClass, escEligible, prcEligible };
}

function activityFor(installType: InstallType) {
  return installType === "new" ? "new_installation_activity" : "replacement_activity";
}

function certificatePayload(baseBuilding: Record<string, unknown>, fields: string[], postcode: string) {
  const building: Record<string, unknown> = {
    ...baseBuilding,
    HVAC1_PDRSAug24_PDRS__postcode: { [ESS_CALC_DATE]: postcode },
  };
  fields.forEach((field) => { building[field] = { [ESS_CALC_DATE]: null }; });
  return { buildings: { building_1: building }, persons: { person1: {} } };
}

async function fetchCertificateCalculation(baseBuilding: Record<string, unknown>, fields: string[], postcode: string) {
  return await fetchJson(ESS_CALCULATE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(certificatePayload(baseBuilding, fields, postcode)),
  });
}

function certificateBuilding(response: unknown) {
  if (!response || typeof response !== "object") return {} as Record<string, unknown>;
  const buildings = (response as { buildings?: Record<string, unknown> }).buildings;
  if (!buildings || typeof buildings !== "object") return {} as Record<string, unknown>;
  const building = buildings.building_1;
  return building && typeof building === "object" ? building as Record<string, unknown> : {};
}

function certificateField(building: Record<string, unknown>, field: string) {
  const values = building[field];
  return values && typeof values === "object"
    ? finiteNumber((values as Record<string, unknown>)[ESS_CALC_DATE])
    : Number.NaN;
}

function decimalEsc(building: Record<string, unknown>) {
  const savings = certificateField(building, "HVAC1_PDRSAug24_electricity_savings");
  const factor = certificateField(building, "HVAC1_PDRSAug24_PDRS__regional_network_factor");
  return Number.isFinite(savings) && Number.isFinite(factor)
    ? savings * factor * 1.06
    : certificateField(building, "HVAC1_PDRSAug24_ESC_calculation");
}

function decimalPrc(building: Record<string, unknown>) {
  const reduction = certificateField(building, "HVAC1_PDRSAug24_peak_demand_reduction_capacity");
  const factor = certificateField(building, "HVAC1_PDRSAug24_get_network_loss_factor_by_postcode");
  return Number.isFinite(reduction) && Number.isFinite(factor)
    ? reduction * factor * 10
    : certificateField(building, "HVAC1_PDRSAug24_PRC_calculation");
}

function isFallbackPostcode(postcode: string) {
  const value = Number(postcode);
  return Number.isInteger(value) && ((value >= 2555 && value <= 2560) || (value >= 2563 && value <= 2574));
}

function proxyPostcode(climateZone: ClimateZone) {
  return climateZone === "hot" ? "2481" : climateZone === "cold" ? "2620" : "2145";
}

async function calculateWithPostcodeFallback(
  baseBuilding: Record<string, unknown>,
  climate: { postcode: string; climateZone: ClimateZone },
  error: unknown,
) {
  if (!isFallbackPostcode(climate.postcode) || !/no field of name 0/i.test(errorMessage(error))) throw error;
  const [escResponse, actualResponse] = await Promise.all([
    fetchCertificateCalculation(baseBuilding, CERTIFICATE_ESC_PROXY_FIELDS, proxyPostcode(climate.climateZone)),
    fetchCertificateCalculation(baseBuilding, CERTIFICATE_ACTUAL_POSTCODE_FIELDS, climate.postcode),
  ]);
  const escBuilding = certificateBuilding(escResponse);
  const actualBuilding = certificateBuilding(actualResponse);
  const merged = { ...escBuilding, ...actualBuilding };
  const savings = certificateField(escBuilding, "HVAC1_PDRSAug24_electricity_savings");
  const factor = certificateField(actualBuilding, "HVAC1_PDRSAug24_PDRS__regional_network_factor");
  if (Number.isFinite(savings) && Number.isFinite(factor)) {
    merged.HVAC1_PDRSAug24_ESC_calculation = { [ESS_CALC_DATE]: savings * factor * 1.06 };
  }
  return { buildings: { building_1: merged }, persons: { person1: {} } };
}

function multiCapacityInputs(meta: Metadata, indoorHeads: SavedMultiHeadRating[]) {
  if (!indoorHeads.length) throw new Error("The saved multi-head quote has no indoor heads");
  const outdoorCooling = finiteNumber(meta["Cooling Capacity"]);
  const outdoorHeating = finiteNumber(meta["Heating Capacity"]);
  const outdoorInputPower = finiteNumber(meta["Input Power"]);
  if (!(outdoorCooling > 0) || !(outdoorHeating > 0) || !(outdoorInputPower > 0)) {
    throw new Error("The outdoor model has incomplete GEMS capacity data");
  }
  const missing = indoorHeads.filter((head) => !(head.ratedCoolingCapacity > 0) || !(head.ratedHeatingCapacity > 0));
  if (missing.length) {
    throw new Error(`The saved multi-head quote is missing rated indoor capacity for ${missing.map((head) => head.model).join(", ")}`);
  }
  const indoorCooling = indoorHeads.reduce((sum, head) => sum + head.ratedCoolingCapacity * head.qty, 0);
  const indoorHeating = indoorHeads.reduce((sum, head) => sum + head.ratedHeatingCapacity * head.qty, 0);
  const coolingRatio = Math.min(indoorCooling / outdoorCooling, 1);
  return {
    cooling: Math.min(indoorCooling, outdoorCooling),
    heating: Math.min(indoorHeating, outdoorHeating),
    inputPower: outdoorInputPower * coolingRatio,
  };
}

async function calculateCertificates(
  meta: Metadata,
  climate: { postcode: string; climateZone: ClimateZone; bcaZone: string },
  input: CurrentRebateInput,
) {
  const airConditionerType = input.systemType === "ducted"
    ? AIR_CONDITIONER_TYPES[1]
    : input.systemType === "multi_split"
      ? AIR_CONDITIONER_TYPES[2]
      : AIR_CONDITIONER_TYPES[0];
  const multi = input.systemType === "multi_split" ? multiCapacityInputs(meta, input.indoorHeads || []) : null;
  const cooling = multi?.cooling ?? finiteNumber(meta["Cooling Capacity"]);
  const heating = multi?.heating ?? finiteNumber(meta["Heating Capacity"]);
  const inputPower = multi?.inputPower ?? finiteNumber(meta["Input Power"]);
  const ratedAeer = finiteNumber(meta["Rated AEER"]);
  const ratedAcop = finiteNumber(meta["Rated ACOP"]);
  const tcec = finiteNumber(meta[`Residential tcec_${climate.climateZone}`]);
  const thec = finiteNumber(meta[`Residential thec_${climate.climateZone}`]);
  const tcspf = finiteNumber(meta["Residential TCSPF_mixed"]);
  const hspfMixed = finiteNumber(meta["Residential HSPF_mixed"]);
  const hspfCold = finiteNumber(meta["Residential HSPF_cold"]);
  const currentEligibility = eligibility(meta, climate.climateZone, input.systemType);
  if ([cooling, heating, ratedAeer, ratedAcop, inputPower, tcec, thec, tcspf, hspfMixed, hspfCold].some((value) => !Number.isFinite(value))) {
    throw new Error("Incomplete model energy rating data");
  }
  if (!currentEligibility.productClass) throw new Error("Incomplete model energy rating data: missing product class");
  if (!currentEligibility.escEligible && !currentEligibility.prcEligible) return { esc: 0, prc: 0 };
  const baseBuilding = {
    HVAC1_PDRSAug24_Activity: { [ESS_CALC_DATE]: activityFor(input.installType) },
    HVAC1_PDRSAug24_Air_Conditioner_type: { [ESS_CALC_DATE]: airConditionerType },
    HVAC1_PDRSAug24_product_class_input: { [ESS_CALC_DATE]: currentEligibility.productClass },
    HVAC1_PDRSAug24_HSPF_cold: { [ESS_CALC_DATE]: hspfCold },
    HVAC1_PDRSAug24_HSPF_mixed: { [ESS_CALC_DATE]: hspfMixed },
    HVAC1_PDRSAug24_PDRS__postcode: { [ESS_CALC_DATE]: climate.postcode },
    HVAC1_PDRSAug24_TCSPF_mixed: { [ESS_CALC_DATE]: tcspf },
    HVAC1_PDRSAug24_cooling_capacity_input: { [ESS_CALC_DATE]: cooling },
    HVAC1_PDRSAug24_heating_capacity_input: { [ESS_CALC_DATE]: heating },
    HVAC1_PDRSAug24_rated_ACOP_input: { [ESS_CALC_DATE]: ratedAcop },
    HVAC1_PDRSAug24_rated_AEER_input: { [ESS_CALC_DATE]: ratedAeer },
    HVAC1_PDRSAug24_residential_TCEC: { [ESS_CALC_DATE]: tcec },
    HVAC1_PDRSAug24_residential_THEC: { [ESS_CALC_DATE]: thec },
    HVAC1_PDRSAug24_input_power: { [ESS_CALC_DATE]: inputPower },
    HVAC1_PDRSAug24_BCA_Climate_Zone: { [ESS_CALC_DATE]: climate.bcaZone },
  };
  let response: unknown;
  try {
    response = await fetchCertificateCalculation(baseBuilding, CERTIFICATE_OUTPUT_FIELDS, climate.postcode);
  } catch (error) {
    response = await calculateWithPostcodeFallback(baseBuilding, climate, error);
  }
  const building = certificateBuilding(response);
  const esc = decimalEsc(building);
  const prc = decimalPrc(building);
  if (!Number.isFinite(esc) || !Number.isFinite(prc)) throw new Error("Unable to calculate certificates");
  const escCap = input.systemType === "multi_split" ? (climate.climateZone === "cold" ? 90 : 70) : Number.POSITIVE_INFINITY;
  const prcCap = input.systemType === "multi_split" ? 500 : Number.POSITIVE_INFINITY;
  return {
    esc: currentEligibility.escEligible ? Math.min(esc, escCap) : 0,
    prc: currentEligibility.prcEligible ? Math.min(prc, prcCap) : 0,
  };
}

function contractMatch(input: CurrentRebateInput) {
  const postcode = Number(input.postcode);
  if (!dcceewPostcodes.has(postcode)) return false;
  const direct = `${normalizeBrand(input.brand)}|${normalize(input.model)}`;
  if (dcceewProductKeys.has(direct)) return true;
  return catalogueProductFor(input.brand, input.model)?.dcceewEligible === true;
}

export async function calculateCurrentNswRebate(input: CurrentRebateInput): Promise<CurrentRebateResult> {
  if (!/^\d{4}$/.test(input.postcode)) throw new Error("The saved quote does not contain a valid customer postcode");
  if (!input.brand.trim() || !input.model.trim()) throw new Error("The saved quote does not contain a brand and model");
  if (!(input.escRate >= 0) || !(input.prcRate >= 0)) throw new Error("The current business certificate payout rates are unavailable");
  const [{ meta, source }, climate] = await Promise.all([
    resolveMetadata(input.brand, input.model),
    resolveClimate(input.postcode),
  ]);
  const certificates = await calculateCertificates(meta, climate, input);
  const contractApplied = contractMatch(input);
  const effectiveEscRate = contractApplied ? DCCEEW_CONTRACT_RATE : input.escRate;
  return {
    rebate: roundMoney((certificates.esc * effectiveEscRate) + (certificates.prc * input.prcRate)),
    esc: certificates.esc,
    prc: certificates.prc,
    escRate: effectiveEscRate,
    prcRate: input.prcRate,
    contractApplied,
    lookupSource: source,
  };
}
