export type BusinessWonRow = {
  brand: string; model: string; type: string; size: string; install: string;
  finalInc: number | null; rebate: number | null; netProfit: number | null;
};
export type BusinessWonJob = {
  key: string; quoteName: string; wonAt: string; salespersonName: string;
  address: string; installationDate: string; rows: BusinessWonRow[];
  customerTotal: number | null; rebateTotal: number | null; installerProfit: number | null;
};
export type BusinessWonJobs = {
  businessId: string; businessName: string; jobs: BusinessWonJob[]; checkedAt: string;
};
export class BusinessWonJobsRefreshing extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isBusinessId(value: string) { return UUID.test(value); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 500) => typeof value === "string" ? value.slice(0, limit) : "";
function savedAmount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}
function total(rows: BusinessWonRow[], field: "finalInc" | "rebate" | "netProfit") {
  if (rows.some(row => row[field] === null)) return null;
  const sum = rows.reduce((value, row) => value + row[field]!, 0);
  return Number.isFinite(sum) ? sum : null;
}

// Project display fields only. No quote normalizer or current pricing formula runs here.
export function businessWonJobsPayload(value: unknown, businessId: string, now = Date.now()): BusinessWonJobs {
  if (!record(value) || value.businessId !== businessId || !Array.isArray(value.jobs) || value.jobs.length > 1000) {
    throw new Error("Invalid business Won Jobs response");
  }
  if (JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error("Business Won Jobs response is too large");
  const keys = new Set<string>();
  let rowCount = 0;
  const jobs = value.jobs.map((input): BusinessWonJob => {
    if (!record(input) || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 200) throw new Error("Invalid job");
    rowCount += input.rows.length;
    if (rowCount > 5000) throw new Error("Business Won Jobs has too many systems");
    const key = text(input.key, 1000), wonAt = text(input.wonAt, 50);
    if (!key || keys.has(key) || !Number.isFinite(Date.parse(wonAt))) throw new Error("Invalid job identity");
    keys.add(key);
    const rows = input.rows.map((row): BusinessWonRow => {
      if (!record(row)) throw new Error("Invalid system");
      return { brand: text(row.brand), model: text(row.model), type: text(row.type), size: text(row.size),
        install: text(row.install), finalInc: savedAmount(row.finalInc), rebate: savedAmount(row.rebate), netProfit: savedAmount(row.netProfit) };
    });
    return { key, wonAt, quoteName: text(input.quoteName) || "Won job", salespersonName: text(input.salespersonName),
      address: text(input.address), installationDate: text(input.installationDate, 50), rows,
      customerTotal: total(rows, "finalInc"), rebateTotal: total(rows, "rebate"), installerProfit: total(rows, "netProfit") };
  }).sort((a, b) => Date.parse(b.wonAt) - Date.parse(a.wonAt) || a.key.localeCompare(b.key));
  return { businessId, businessName: text(value.businessName), jobs, checkedAt: new Date(now).toISOString() };
}

// Auth is deliberately outside this cache and must be checked for every request.
export function createBusinessWonJobsCache(now = Date.now) {
  const cache = new Map<string, { expires: number; value: Promise<BusinessWonJobs> }>();
  return async (businessId: string, load: () => Promise<BusinessWonJobs>) => {
    const existing = cache.get(businessId);
    if (existing && existing.expires > now()) return existing.value;
    if (cache.size >= 20) cache.delete(cache.keys().next().value!);
    const entry = { expires: now() + 30_000, value: Promise.resolve().then(load) };
    cache.set(businessId, entry);
    try { return await entry.value; }
    catch (error) { if (cache.get(businessId) === entry) cache.delete(businessId); throw error; }
  };
}
