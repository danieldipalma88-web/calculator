import catalogue from "./public-rebate-catalogue.generated.json";
import {
  fetchGemsDatastoreRecords,
  isEligibleAustralianGemsRecord,
  mapGemsModelSearchItem,
  type GemsSearchRecord,
} from "./gems-model-search";
import {
  calculateVerifiedGemsCertificates,
  type CurrentRebateInput,
  type CurrentRebateResult,
} from "./nsw-hvac-rebate";

export type ModelRequestVerificationInput = {
  system_type: string;
  brand: string;
  model: string;
  capacity: string;
  phase: string;
  postcode: string;
  install_type: string;
};

type Evidence = Record<string, unknown>;
type VerifiedProduct = {
  systemType: "split" | "ducted";
  brand: string;
  model: string;
  series: string;
  capacityKw: number;
  phase: "Single" | "Three";
};

export type ModelRequestVerificationResult =
  | { kind: "verified"; product: VerifiedProduct; evidence: Evidence }
  | { kind: "clarify"; reason: string; candidates: string[]; evidence?: Evidence }
  | { kind: "review"; reason: string; evidence?: Evidence };

type Dependencies = {
  fetchRecords?: typeof fetchGemsDatastoreRecords;
  calculateRebate?: (input: CurrentRebateInput, record: GemsSearchRecord) => Promise<
    CurrentRebateResult & { registryRecord?: GemsSearchRecord }
  >;
};

const INVENTORY_LIMIT = 10_000;
const GEMS_SOURCE_URL = "https://data.gov.au/data/api/3/action/datastore_search_sql";
const CATALOGUE_BRANDS = new Map(catalogue.products.map(({ brand }) => [brand.toUpperCase(), brand]));
const POSITIVE_RATINGS = [
  "Cooling Capacity", "Heating Capacity", "Input Power", "Rated AEER", "Rated ACOP",
  "Residential TCSPF_mixed", "Residential HSPF_mixed", "Residential HSPF_cold",
];
const SEASONAL_CONSUMPTION = [
  "Residential tcec_hot", "Residential tcec_mixed", "Residential tcec_cold",
  "Residential thec_hot", "Residential thec_mixed", "Residential thec_cold",
];
const INVENTORY_FIELDS = [
  "_id", "Registration Number", "Submit_ID", "Brand", "Model_No", "Family Name",
  "SubmitStatus", "Availability Status", "Sold_in", "ExpDate", "Configuration1",
  "Configuration2", "ApplStandard", "Outdoor unit only", "Phase", "Product Class",
  "C-Total Cool Rated", "H-Total Heat Rated", "C-Power_Inp_Rated",
  ...POSITIVE_RATINGS.slice(3), ...SEASONAL_CONSUMPTION,
];

function review(reason: string, evidence?: Evidence): ModelRequestVerificationResult {
  return evidence ? { kind: "review", reason, evidence } : { kind: "review", reason };
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function componentCode(value: string) {
  return /^[A-Z0-9][A-Z0-9 ._+()-]*$/i.test(value);
}

function pairKey(model: string) {
  const parts = model.split("/").map((part) => part.trim().toUpperCase());
  if (parts.length !== 2 || parts[0] === parts[1]
    || parts.some((part) => !componentCode(part))) return "";
  return parts.sort().join("/");
}

function phaseFor(value: string): VerifiedProduct["phase"] | null {
  if (/^(single|1)(?:[ -]phase)?$/i.test(value)) return "Single";
  if (/^(three|3)(?:[ -]phase)?$/i.test(value)) return "Three";
  return null;
}

function number(value: unknown) {
  if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function activeAustralian(record: GemsSearchRecord) {
  const soldIn = text(record.Sold_in) || text(record["Sold in"]);
  if (!isEligibleAustralianGemsRecord(record)
    || !soldIn.split(/[,;]/).some((country) => /^australia$/i.test(country.trim()))) return false;
  if (record.ExpDate == null) return true;
  const expiry = text(record.ExpDate);
  return /^\d{4}-\d{2}-\d{2}$/.test(expiry)
    && Number.isFinite(Date.parse(expiry))
    && new Date(expiry).toISOString().slice(0, 10) === expiry
    && expiry >= new Date().toISOString().slice(0, 10);
}

function registryEvidence(record: GemsSearchRecord) {
  return {
    rowId: record._id ?? null,
    registrationNumber: record["Registration Number"] ?? null,
    submissionId: record.Submit_ID ?? null,
    brand: record.Brand ?? null,
    model: record.Model_No ?? null,
    configuration1: record.Configuration1 ?? null,
    configuration2: record.Configuration2 ?? null,
    applicationStandard: record.ApplStandard ?? null,
    outdoorOnly: record["Outdoor unit only"] ?? record["Outdoor Unit Only"] ?? null,
    submitStatus: record.SubmitStatus ?? null,
    availability: record["Availability Status"] ?? null,
    soldIn: record.Sold_in ?? record["Sold in"] ?? null,
    expiresOn: record.ExpDate ?? null,
  };
}

export async function verifyRequestedModel(
  input: ModelRequestVerificationInput,
  { fetchRecords = fetchGemsDatastoreRecords, calculateRebate = calculateVerifiedGemsCertificates }: Dependencies = {},
): Promise<ModelRequestVerificationResult> {
  const systemType = text(input.system_type).toLowerCase();
  if (systemType !== "split" && systemType !== "ducted") return review("Unsupported system type");

  const brand = text(input.brand);
  const model = text(input.model);
  const requestedPair = pairKey(model);
  const requestedComponent = !requestedPair && componentCode(model) ? model.toUpperCase() : "";
  const postcode = text(input.postcode);
  const installType = text(input.install_type).toLowerCase();
  const missingInstallation = !/^\d{4}$/.test(postcode) || postcode === "0000" || (installType !== "new" && installType !== "replacement");
  const installationQuestion = missingInstallation ? " Please also confirm the installation postcode and whether it is new or a replacement." : "";
  if (!brand || brand.length > 100 || /[\x00-\x1f\x7f]/.test(brand)) return review("An exact brand is required");
  if (!requestedPair && !requestedComponent) return {
    kind: "clarify", reason: "Please enter the exact indoor and outdoor model codes from the equipment labels." + installationQuestion, candidates: [],
  };

  const phaseInput = text(input.phase);
  const requestedPhase = phaseFor(phaseInput);
  if (phaseInput && phaseInput.toLowerCase() !== "unknown" && !requestedPhase) return review("Unrecognised requested phase");
  const capacityInput = text(input.capacity);
  const requestedCapacity = number(capacityInput.replace(/\s*kw$/i, ""));
  if (capacityInput && !(requestedCapacity > 0)) return review("Unrecognised requested capacity");

  // A brand inventory avoids ranked model search dropping exact but conflicting rows.
  const records = await fetchRecords({ brand, fields: INVENTORY_FIELDS, limit: INVENTORY_LIMIT, revalidateSeconds: 0 });
  if (records.length >= INVENTORY_LIMIT) return review("GEMS brand inventory may be truncated");
  const matches = records.filter((record) => {
    const key = pairKey(text(record.Model_No));
    return Boolean(key) && text(record.Brand).toUpperCase() === brand.toUpperCase()
      && (requestedPair ? key === requestedPair : key.split("/").includes(requestedComponent))
      && activeAustralian(record);
  });
  if (matches.length !== 1) {
    const pairs = new Map(matches.map(record => [pairKey(text(record.Model_No)), text(record.Model_No)]));
    if (!matches.length) return {
      kind: "clarify", reason: "We couldn't verify that code in the Australian register. Please check both model numbers on the equipment labels." + installationQuestion, candidates: [],
    };
    if (!requestedPair && pairs.size > 1) return {
      kind: "clarify", reason: "More than one registered model pair contains that code. Please choose the exact pair on your equipment." + installationQuestion,
      candidates: [...pairs.values()].slice(0, 12), evidence: { registrations: matches.slice(0, 12).map(registryEvidence) },
    };
    return review("Multiple active Australian GEMS registrations match this pair", { registrations: matches.slice(0, 12).map(registryEvidence) });
  }

  const [record] = matches;
  const evidence: Evidence = { sourceUrl: GEMS_SOURCE_URL, registry: registryEvidence(record), postcode, installType, matchedComponent: requestedComponent || null };
  const item = mapGemsModelSearchItem(record);
  const outdoorFlag = record["Outdoor unit only"] ?? record["Outdoor Unit Only"];
  const application = (text(record.ApplStandard) || text(record["Application Standard"]))
    .replace(/\bnon[ -]+multi[ -]?(?:split|head)\b/gi, "");
  if (!item || item.outdoorOnly || item.multiHead || item.multiSplitOutdoor
    || /\bmulti[ -]?(?:split|head)\b/i.test(application)
    || (outdoorFlag != null && !/^(?:no|false|0|n\/a|-)?$/i.test(String(outdoorFlag).trim()))
    || !/^single split system$/i.test(text(record.Configuration2))) {
    return review("GEMS does not confirm a complete single split system", evidence);
  }

  const configuration = text(record.Configuration1);
  const registryType = /^non[ -]ducted$/i.test(configuration) ? "split" : /^ducted$/i.test(configuration) ? "ducted" : null;
  if (registryType !== systemType) return review("Requested system type does not match GEMS Configuration1", evidence);

  const { metadata } = item;
  const invalidRatings = [
    ...POSITIVE_RATINGS.filter((field) => !(number(metadata[field]) > 0)),
    ...SEASONAL_CONSUMPTION.filter((field) => !(number(metadata[field]) >= 0)),
  ];
  if (invalidRatings.length) return review("GEMS energy ratings are missing or invalid", { ...evidence, invalidRatings });

  const capacityKw = number(metadata["Cooling Capacity"]);
  const phase = phaseFor(item.phase);
  if (!phase || (requestedPhase && requestedPhase !== phase)) return review("GEMS phase is missing or conflicts with the request", evidence);
  if (capacityInput && requestedCapacity !== capacityKw) return review("Requested capacity conflicts with GEMS cooling capacity", evidence);
  if (missingInstallation) return {
    kind: "clarify", reason: "Please confirm the installation postcode and whether it is a new installation or a replacement.",
    candidates: [item.model], evidence,
  };

  evidence.ratings = metadata;
  let result: Awaited<ReturnType<NonNullable<Dependencies["calculateRebate"]>>>;
  try {
    result = await calculateRebate({
      brand: item.brand, model: item.model, systemType, postcode, installType, escRate: 1, prcRate: 1,
    }, record);
  } catch (error) {
    if (error instanceof Error && /^(?:Unable to resolve climate zones for postcode \d{4}|Unable to calculate certificates|Incomplete model energy rating data(?:: missing product class)?)$/.test(error.message)) {
      return review("NSW certificate calculation lacks required data", evidence);
    }
    throw error;
  }

  const { esc, prc, lookupSource, registryRecord } = result;
  evidence.certificates = { esc: Number.isFinite(esc) ? esc : null, prc: Number.isFinite(prc) ? prc : null, lookupSource };
  if (!Number.isFinite(esc) || !Number.isFinite(prc) || esc < 0 || prc < 0 || (esc === 0 && prc === 0)) {
    return review("NSW calculation did not confirm positive certificates", evidence);
  }

  // Certificate evidence must identify the same registration and ratings.
  const usedMetadata = registryRecord && mapGemsModelSearchItem(registryRecord)?.metadata;
  if (!registryRecord || !usedMetadata
    || JSON.stringify(registryEvidence(registryRecord)) !== JSON.stringify(registryEvidence(record))
    || Object.keys(metadata).some((key) => usedMetadata[key] !== metadata[key])) {
    return review("NSW certificate calculation is not bound to the exact GEMS registration", evidence);
  }

  return {
    kind: "verified",
    product: {
      systemType,
      brand: CATALOGUE_BRANDS.get(item.brand.toUpperCase()) ?? item.brand,
      model: item.model,
      series: item.family || (systemType === "ducted" ? "Ducted" : "Split system"),
      capacityKw,
      phase,
    },
    evidence: { ...evidence, verifiedAt: new Date().toISOString() },
  };
}
