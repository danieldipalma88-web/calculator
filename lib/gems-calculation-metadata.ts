import catalogue from "./public-rebate-catalogue.generated.json";
import { conservativeRegistrationIds, fetchGemsDatastoreRecords, GEMS_AIRCON_RESOURCE_IDS, GEMS_VERIFIED_INVENTORY_SOURCE, isGemsMultiSplitOutdoorRecord, type GemsSearchRecord } from "./gems-model-search";

export const GEMS_INVENTORY_REVALIDATE_SECONDS = 300;
export const GEMS_INVENTORY_MAX_AGE_MS = 60 * 60 * 1000;
const DEADLINE_MS = 8000;
const FAILURE_COOLDOWN_MS = 5000;
const MAX_IN_FLIGHT = 8;
const MAX_RECENT_INVENTORIES = 8;
const MAX_COOLDOWNS = 128;
const MAX_INVENTORY_BYTES = 1_800_000;
const SOURCE = "GEMS registry + NSW formula" as const;

const errors = {
  GEMS_INVALID_REQUEST: [400, "Enter a valid brand and exact registered model."],
  GEMS_MODEL_NOT_FOUND: [404, "No exact eligible GEMS registration was found."],
  GEMS_MODEL_CONFLICT: [409, "Exact GEMS registrations disagree. Model data could not be verified."],
  GEMS_MODEL_INCOMPLETE: [422, "The exact GEMS registration has missing or invalid energy ratings."],
  GEMS_MODEL_REJECTED: [422, "The exact GEMS registration is inactive, unavailable, expired, or not verified for this system in Australia."],
  GEMS_UNAVAILABLE: [503, "Verified GEMS model data is temporarily unavailable."],
} as const;

export class GemsCalculationMetadataError extends Error {
  readonly code: keyof typeof errors;
  readonly status: (typeof errors)[keyof typeof errors][0];
  constructor(code: keyof typeof errors) {
    super(errors[code][1]);
    this.name = "GemsCalculationMetadataError";
    this.code = code;
    this.status = errors[code][0];
  }
}

const fail = (code: keyof typeof errors): never => { throw new GemsCalculationMetadataError(code); };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
const brandSyntax = /^[A-Z0-9][A-Z0-9 .&'()+_-]*$/i;
const modelSyntax = /^[A-Z0-9][A-Z0-9 ._+()\/|&,-]*$/i;
const brandGroups = [
  ["Fujitsu General", "Fujitsu"], ["Actron Air", "Actron"], ["Samsung", "Samsung Electronics"],
  ["Mitsubishi Heavy Industries", "Mitsubishi HI"], ["Emerald", "Emerald Energy"], ["Smart User", "Smartuser"],
];
const brandsByKey = new Map(brandGroups.flatMap(group => group.map(name => [compact(name), group] as const)));
for (const { brand } of catalogue.products) if (!brandsByKey.has(compact(brand))) brandsByKey.set(compact(brand), [brand]);
const brandNames = (brand: string) => (brandsByKey.get(compact(brand)) ?? [brand]).map(name => name.toLowerCase());
const brandKey = (brand: string) => brandNames(brand)[0];

function pairParts(value: string) {
  // A spaced separator takes precedence over slashes inside Gree/TCL model codes.
  const spaced = value.split(/\s+\/\s+|\s+-\s+|\s*\|\s*/);
  const parts = (spaced.length === 1 ? value.split("/") : spaced).map(part => part.trim());
  return parts.length === 2 && parts.every(part => compact(part).length >= 3) && compact(parts[0]) !== compact(parts[1]) ? parts : null;
}

const pairKey = (parts: string[]) => parts.map(compact).sort().join("|");
const formattedPairKey = (brand: string, value: string) => `${brand}:${value.toUpperCase().replace(/\s+/g, "")}`;
const knownPairFormats = new Map<string, Set<string>>();
const aliases = new Map<string, Set<string>>();
const packageAliases = new Set<string>();
const catalogueComponents = new Set<string>();
function addKeys(target: Map<string, Set<string>>, key: string, values: string[]) {
  const prior = target.get(key) ?? new Set<string>();
  for (const value of values) prior.add(value);
  target.set(key, prior);
}
for (const product of catalogue.products) {
  const brand = brandKey(product.brand);
  const names = [...new Set([product.model, ...product.modelAliases])];
  const pairs = names.map(pairParts).filter((parts): parts is string[] => !!parts);
  const pairKeys = pairs.map(pairKey);
  const components = new Set(pairs.flatMap(parts => parts.map(compact)));
  for (const component of components) catalogueComponents.add(`${brand}:${component}`);
  // A documented package can identify the pair in either direction, but a component cannot.
  const packages = names.filter(name => pairKeys.length && !pairParts(name) && !/[\/|]/.test(name) && !components.has(compact(name))).map(compact);
  const related = [...pairKeys.map(key => `pair:${key}`), ...packages.map(key => `package:${key}`)];
  for (const parts of pairs) {
    for (const value of [parts.join("/"), [...parts].reverse().join("/")]) {
      addKeys(knownPairFormats, formattedPairKey(brand, value), [pairKey(parts)]);
    }
    addKeys(aliases, `${brand}:pair:${pairKey(parts)}`, related);
  }
  for (const key of packages) {
    packageAliases.add(`${brand}:${key}`);
    addKeys(aliases, `${brand}:single:${key}`, related);
  }
}
const standaloneSystems = new Set(catalogue.products.filter(({ brand, model }) =>
  !pairParts(model) && !/[\/|\\]/.test(model) && !catalogueComponents.has(`${brandKey(brand)}:${compact(model)}`),
).map(({ brand, model }) => `${brandKey(brand)}:${compact(model)}`));

function modelIdentity(brand: string, model: string) {
  const parts = pairParts(model);
  if (parts) return `pair:${pairKey(parts)}`;
  if (/[\/|]/.test(model)) {
    const keys = knownPairFormats.get(formattedPairKey(brand, model));
    return keys?.size === 1 ? `pair:${keys.values().next().value}` : null;
  }
  return `single:${compact(model)}`;
}

const requiredRatingKeys = [
  "Cooling Capacity", "Heating Capacity", "Input Power", "Rated AEER", "Rated ACOP",
  "Residential TCSPF_mixed", "Residential HSPF_mixed", "Residential HSPF_cold",
  "Residential tcec_hot", "Residential tcec_mixed", "Residential tcec_cold",
  "Residential thec_hot", "Residential thec_mixed", "Residential thec_cold",
] as const;
const ratingKeys = [...requiredRatingKeys, "Residential TCSPF_cold", "Residential TCSPF_hot", "Residential HSPF_hot"] as const;
const positiveRatingKeys = new Set<string>(["Cooling Capacity", "Input Power", "Rated AEER"]);
const descriptorKeys = ["Product Type", "Product Class", "Configuration2", "Phase"] as const;
const ratingAliases: Record<string, string[]> = {
  "Cooling Capacity": ["C-Total Cool Rated", "Cooling Capacity", "Rated Total Cool Capacity kW"],
  "Heating Capacity": ["H-Total Heat Rated", "Heating Capacity", "Rated Heating Capacity kW"],
  "Input Power": ["C-Power_Inp_Rated", "Input Power", "Rated cooling power input kW"],
};
function valueFor(row: GemsSearchRecord, keys: readonly string[]) {
  return keys.map(key => row[key]).find(value => typeof value === "number" || (typeof value === "string" && value.trim()));
}
function numericSyntax(value: unknown): value is string | number {
  return typeof value === "number" || (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()));
}
function numeric(value: unknown): value is string | number {
  return numericSyntax(value) && Number.isFinite(Number(value));
}

type Meta = Record<string, string | number>;
type Candidate = { identity: string; meta: Meta; registryExpiresAt: number | null; state: "eligible" | "unknown" | "rejected"; complete: boolean; invalidRatings: boolean; conflictingRatings?: true; resource?: GemsSearchRecord[typeof GEMS_VERIFIED_INVENTORY_SOURCE]; registration?: string };
type Inventory = { brand: string; verifiedAt: number; candidates: Candidate[] };
type FetchInventory = (brands: readonly string[], signal: AbortSignal) => Promise<GemsSearchRecord[]>;
type ReadInventory = (brand: string) => Promise<Inventory>;

function registrationExpiry(value: unknown) {
  if (value == null) return null; // Older records omit expiry; do not invent one.
  const expiry = text(value);
  const day = Date.parse(expiry);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== expiry) return 0;
  return day + 86_400_000;
}

function inventoryCandidates(records: GemsSearchRecord[], key: string) {
  const candidates: Candidate[] = [];
  for (const row of records) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("GEMS_UNAVAILABLE");
    const brand = text(valueFor(row, ["Brand", "Brand Name", "brand"]));
    if (!brand || brandKey(brand) !== key) fail("GEMS_UNAVAILABLE");
    const model = text(valueFor(row, ["Model_No", "Model No", "Model Number", "model"]));
    let identity = modelIdentity(key, model);
    if (!identity || compact(model).length < 3) continue;
    const outdoorFlags = [row["Outdoor unit only"], row["Outdoor Unit Only"]].filter(value => value != null && value !== "");
    const outdoorOnly = outdoorFlags.some(value => value === true || value === 1 || /^(yes|true|1)$/i.test(text(value)));
    let validSystem = !outdoorOnly;
    if (identity.startsWith("single:")) {
      const standard = text(valueFor(row, ["ApplStandard", "Application Standard"])).replace(/\bnon[ -]+multi[ -]?split\b/gi, "");
      const multi = isGemsMultiSplitOutdoorRecord({ ...row, ApplStandard: standard });
      const knownStandalone = standaloneSystems.has(`${key}:${compact(model)}`);
      const standalone = knownStandalone && compact(text(row.Configuration2)) === "SINGLESPLITSYSTEM"
        && outdoorFlags.length > 0 && outdoorFlags.every(value => value === false || value === 0 || /^(no|false|0)$/i.test(text(value)));
      if (packageAliases.has(`${key}:${compact(model)}`)) {
        identity = `package:${compact(model)}`;
        validSystem = knownStandalone ? standalone : !outdoorOnly && !multi;
      } else validSystem = multi || standalone;
    }
    const approval = text(row.SubmitStatus).toLowerCase();
    const availability = text(row["Availability Status"]).toLowerCase();
    const market = text(valueFor(row, ["Sold_in", "Sold in"]));
    const australia = market.split(/[,;]/).some(country => /^australia$/i.test(country.trim()));
    const state = !validSystem || (approval && approval !== "approved") || (availability && availability !== "available") || (market && !australia)
      ? "rejected" : approval === "approved" && availability === "available" && australia ? "eligible" : "unknown";
    const registryExpiresAt = registrationExpiry(row.ExpDate);
    if (state === "rejected") {
      candidates.push({ identity, meta: { brand, model }, registryExpiresAt, state, complete: false, invalidRatings: false });
      continue;
    }
    const meta: Meta = {
      brand, model,
      "Product Type": text(valueFor(row, ["Configuration1", "Product Type"])),
      "Product Class": text(valueFor(row, ["Product Class", "Product_Class", "ProductClass"])),
      Configuration2: text(row.Configuration2),
      ApplStandard: text(valueFor(row, ["ApplStandard", "Application Standard"])),
      Phase: text(valueFor(row, ["Phase", "Power Phase", "Power supply phase"])),
    };
    let invalidRatings = false;
    let conflictingRatings: true | undefined;
    for (const field of ratingKeys) {
      const fields = ratingAliases[field] ?? [field];
      const rawValues = fields.map(key => row[key]);
      if (rawValues.some(raw => {
        if (!numericSyntax(raw)) return false;
        const rating = Number(raw);
        return !Number.isFinite(rating) || (positiveRatingKeys.has(field) ? rating <= 0 : rating < 0);
      })) invalidRatings = true;
      const values = rawValues.filter(numeric);
      if (new Set(values.map(Number)).size > 1) conflictingRatings = true;
      meta[field] = values[0] ?? "";
    }
    candidates.push({ identity, meta, registryExpiresAt, state, invalidRatings, conflictingRatings,
      complete: !invalidRatings && requiredRatingKeys.every(field => numeric(meta[field])),
      resource: row[GEMS_VERIFIED_INVENTORY_SOURCE], registration: text(row["Registration Number"]).toUpperCase(),
    });
  }
  return candidates;
}

function canonicalDescriptor(field: string, value: string) {
  const key = compact(value);
  if (field === "Product Class" && /^(?:CLASS)?\d+$/.test(key)) return key.replace(/^CLASS/, "");
  if (field === "Phase" && /^(?:SINGLE|1)(?:PHASE)?$/.test(key)) return "SINGLE";
  if (field === "Phase" && /^(?:THREE|3)(?:PHASE)?$/.test(key)) return "THREE";
  return key;
}

function matchesRoundedLegacy(modern: string | number, legacy: string | number) {
  if (typeof modern !== "string" || !/^\d+\.\d{3}$/.test(modern.trim())) return false;
  const decimal = String(legacy).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!decimal) return false;
  const fraction = decimal[2] ?? "";
  const lower = Number(decimal[1]) * 1000 + Number(fraction.slice(0, 3).padEnd(3, "0"));
  const rounded = lower + Number((fraction[3] ?? "0") >= "5");
  // Same-registration exports can resolve an exact half-thousandth either way.
  // This only reconciles the mirror; calculations retain the precise source value.
  const exactHalf = fraction[3] === "5" && /^0*$/.test(fraction.slice(4));
  return Number.isSafeInteger(rounded) && (rounded / 1000 === Number(modern)
    || (exactHalf && lower / 1000 === Number(modern)));
}

function checkRatingEvidence(current: Candidate[], active: Candidate[], field: string) {
  const legacy = active.filter(row => numeric(row.meta[field]));
  const unknown = current.filter(row => row.state === "unknown" && numeric(row.meta[field]));
  const legacyValues = new Set(legacy.map(row => Number(row.meta[field])));
  const unknownValues = new Set(unknown.map(row => Number(row.meta[field])));
  if (legacyValues.size > 1 || unknownValues.size > 1) fail("GEMS_MODEL_CONFLICT");
  if (!legacy.length || !unknown.length || Number(legacy[0].meta[field]) === Number(unknown[0].meta[field])) return;
  // Only AEER/ACOP have verified three-decimal mirrors in the labelled export.
  if (field !== "Rated AEER" && field !== "Rated ACOP") fail("GEMS_MODEL_CONFLICT");
  const registration = legacy[0].registration;
  if (!registration || legacy.some(row => row.resource !== GEMS_AIRCON_RESOURCE_IDS[1] || row.registration !== registration)
    || unknown.some(row => row.resource !== GEMS_AIRCON_RESOURCE_IDS[0] || row.registration !== registration
      || !matchesRoundedLegacy(row.meta[field], legacy[0].meta[field]))) fail("GEMS_MODEL_CONFLICT");
}

function selectCandidate(candidates: Candidate[], identities: Set<string>, now: number) {
  const matches = candidates.filter(row => identities.has(row.identity));
  if (!matches.length) return fail("GEMS_MODEL_NOT_FOUND");
  const current = matches.filter(row => row.state !== "rejected" && (row.registryExpiresAt === null || now < row.registryExpiresAt));
  if (current.some(row => row.invalidRatings)) return fail("GEMS_MODEL_INCOMPLETE");
  const active = current.filter(row => row.state === "eligible");
  if (!active.length) {
    if (matches.some(row => row.state === "rejected" || (row.registryExpiresAt !== null && now >= row.registryExpiresAt))) return fail("GEMS_MODEL_REJECTED");
    return fail("GEMS_MODEL_INCOMPLETE");
  }
  const complete = active.filter(row => row.complete);
  if (!complete.length) return fail("GEMS_MODEL_INCOMPLETE");
  if (current.some(row => row.conflictingRatings)) return fail("GEMS_MODEL_CONFLICT");
  const evidence = new Map<string, string | number>();
  const put = (field: string, value: string | number) => {
    if (evidence.has(field) && evidence.get(field) !== value) fail("GEMS_MODEL_CONFLICT");
    evidence.set(field, value);
  };
  for (const field of ratingKeys) checkRatingEvidence(current, active, field);
  for (const row of active) {
    for (const field of descriptorKeys) {
      const value = canonicalDescriptor(field, String(row.meta[field]));
      if (value) put(field, value);
    }
  }
  const score = (row: Candidate) => (row.meta["Product Class"] ? 16 : 0)
    + descriptorKeys.filter(field => row.meta[field]).length + ratingKeys.filter(field => numeric(row.meta[field])).length;
  return complete.map(row => ({ row, score: score(row), key: JSON.stringify(row.meta) })).sort((a, b) =>
    b.score - a.score || (b.row.registryExpiresAt ?? Infinity) - (a.row.registryExpiresAt ?? Infinity)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0].row;
}

function boundedSingleFlight<T>(work: (key: string) => Promise<T>, now: () => number) {
  const pending = new Map<string, Promise<T>>();
  const failures = new Map<string, number>();
  return (key: string): Promise<T> => {
    const active = pending.get(key);
    if (active) return active;
    if ((failures.get(key) ?? 0) > now() || pending.size >= MAX_IN_FLIGHT) return Promise.reject(new GemsCalculationMetadataError("GEMS_UNAVAILABLE"));
    failures.delete(key);
    const promise = Promise.resolve().then(() => work(key)).catch(() => {
      failures.set(key, now() + FAILURE_COOLDOWN_MS);
      if (failures.size > MAX_COOLDOWNS) failures.delete(failures.keys().next().value!);
      return fail("GEMS_UNAVAILABLE");
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}

async function withinDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GemsCalculationMetadataError("GEMS_UNAVAILABLE")), ms);
    })]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const readGemsInventory: FetchInventory = (brands, signal) => fetchGemsDatastoreRecords({
  limit: 10_000, revalidateSeconds: 0, verifiedInventory: { brands, signal },
});

export function createGemsCalculationMetadata({
  fetchInventory = readGemsInventory, now = Date.now, wrapInventory = load => load, deadlineMs = DEADLINE_MS,
}: { fetchInventory?: FetchInventory; now?: () => number; wrapInventory?: (load: ReadInventory) => ReadInventory; deadlineMs?: number } = {}) {
  const recent = new Map<string, Inventory>();
  const recoveryBridges = new WeakSet<Inventory>();
  // Coalesce inside the cache loader too: Next can start background revalidation independently of the request read.
  const load = boundedSingleFlight(async (brand) => {
    const previous = recent.get(brand);
    const age = previous ? now() - previous.verifiedAt : Infinity;
    if (previous && recoveryBridges.has(previous) && age >= 0 && age < GEMS_INVENTORY_REVALIDATE_SECONDS * 1000) return previous;
    const candidates = await withinDeadline(deadlineMs, async signal => inventoryCandidates(await fetchInventory(brandNames(brand), signal), brand));
    const inventory: Inventory = { brand, verifiedAt: now(), candidates };
    if (Buffer.byteLength(JSON.stringify(inventory)) > MAX_INVENTORY_BYTES) return fail("GEMS_UNAVAILABLE");
    recent.delete(brand);
    recent.set(brand, inventory);
    if (recent.size > MAX_RECENT_INVENTORIES) recent.delete(recent.keys().next().value!);
    return inventory;
  }, now);
  const readCached = wrapInventory(load);
  const read = boundedSingleFlight(brand => withinDeadline(deadlineMs + 100, async signal => {
    const inventory = await readCached(brand);
    signal.throwIfAborted();
    const age = now() - inventory?.verifiedAt;
    if (inventory?.brand !== brand || !Array.isArray(inventory?.candidates) || !Number.isSafeInteger(inventory.verifiedAt) || !Number.isFinite(age) || age < 0) return fail("GEMS_UNAVAILABLE");
    if (age < GEMS_INVENTORY_MAX_AGE_MS) return inventory;
    // SWR may return a hard-expired entry while load is already refreshing it.
    // Join that refresh, or reuse its just-completed result without extending its age.
    const refreshed = recent.get(brand);
    const refreshedAge = refreshed ? now() - refreshed.verifiedAt : Infinity;
    if (refreshed && refreshedAge >= 0 && refreshedAge < GEMS_INVENTORY_REVALIDATE_SECONDS * 1000) {
      recoveryBridges.add(refreshed);
      return refreshed;
    }
    const fresh = await load(brand);
    recoveryBridges.add(fresh);
    return fresh;
  }), now);

  return async function lookup(rawBrand: string | null, rawModel: string | null, options: { registrationEstimate?: boolean } = {}) {
    const brand = text(rawBrand);
    const model = text(rawModel);
    if (rawBrand === null || rawModel === null || rawBrand.length > 100 || rawModel.length > 160 || /[\x00-\x1f\x7f]/.test(rawBrand + rawModel)
      || !brandSyntax.test(brand) || !modelSyntax.test(model) || compact(brand).length < 2 || compact(model).length < 3) return fail("GEMS_INVALID_REQUEST");
    const key = brandKey(brand);
    const identity = modelIdentity(key, model);
    if (!identity) return fail("GEMS_INVALID_REQUEST");
    const related = aliases.get(`${key}:${identity}`);
    const identities = related ? new Set(related) : new Set([identity]);
    const registrationIds = conservativeRegistrationIds(brand, model);
    // Older clients interpret provider failures as permission to use a single bundled row.
    if (registrationIds && !options.registrationEstimate) return fail("GEMS_MODEL_CONFLICT");
    const inventory = await read(key);
    const current = now();
    const maxAgeExpiry = inventory.verifiedAt + GEMS_INVENTORY_MAX_AGE_MS;
    if (current >= maxAgeExpiry) return fail("GEMS_UNAVAILABLE");
    const matches = inventory.candidates.filter(row => identities.has(row.identity));
    if (registrationIds && matches.some(row => row.state !== "rejected" && (row.registryExpiresAt === null || current < row.registryExpiresAt)
      && (!row.registration || !registrationIds.includes(row.registration)))) return fail("GEMS_MODEL_CONFLICT");
    // This is an explicit estimate over two independently verified registrations, not a resolution of their disagreement.
    const candidates = registrationIds
      ? registrationIds.map(registration => {
        const evidence = matches.filter(row => row.registration === registration);
        if (GEMS_AIRCON_RESOURCE_IDS.some(resource => !evidence.some(row => row.resource === resource
          && row.state !== "rejected" && row.registryExpiresAt !== null && current < row.registryExpiresAt
          // The labelled export omits input power; its other ratings must corroborate the detailed export.
          && ratingKeys.every(field => (resource === GEMS_AIRCON_RESOURCE_IDS[0] && field === "Input Power") || numeric(row.meta[field]))))) return fail("GEMS_MODEL_INCOMPLETE");
        return selectCandidate(evidence, identities, current);
      })
      : [selectCandidate(inventory.candidates, identities, current)];
    const candidate = candidates[0];
    const evidenceExpiries = registrationIds ? matches.filter(row => row.state !== "rejected"
      && row.registryExpiresAt !== null && current < row.registryExpiresAt).map(row => row.registryExpiresAt!) : [];
    const expiresAt = Math.min(maxAgeExpiry, ...candidates.map(row => row.registryExpiresAt ?? Infinity), ...evidenceExpiries);
    return { schemaVersion: 1 as const, meta: candidate.meta, brand: candidate.meta.brand, model: candidate.meta.model,
      source: SOURCE, verifiedAt: inventory.verifiedAt, expiresAt,
      ...(registrationIds ? { registrationEstimate: { policy: "lower-total-v1" as const,
        candidates: candidates.map(row => ({ registration: row.registration!, meta: row.meta })) } } : {}) };
  };
}
