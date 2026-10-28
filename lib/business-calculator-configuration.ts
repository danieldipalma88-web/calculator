export const BUSINESS_CONFIGURATION_STORAGE_KEY = "installerBusinessConfigurationV1";

type Bounds = { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean };
type Product = {
  type: "split" | "ducted"; brand: string; series: string; model: string;
  capacityNum: number; phase: "Single" | "Three";
  nswOnly?: boolean; indoorModel?: string; outdoorModel?: string;
  defaultCostCapacityNum?: number; capacityLabel?: string;
};
type CostRule = {
  id: string; system: "split" | "ducted"; install: "new" | "replacement";
  range: string | Bounds; rangeLabel: string; labour: number; materials: number; power: number;
};
export type BusinessCalculatorConfiguration = {
  schemaVersion: 1; businessId: string; revision: string; products: Product[]; defaultCostRules: CostRule[];
};

// Self-contained: the raw route also supplies this exact validator to the browser.
export function validateBusinessCalculatorConfiguration(value: unknown, businessId: unknown): BusinessCalculatorConfiguration | null {
  try {
    if (typeof value !== "string" || value.length > 262144 || typeof businessId !== "string") return null;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(businessId)) return null;
    const input = JSON.parse(value);
    const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
    const text = (item: unknown, limit = 180): item is string => typeof item === "string" && item.length > 0 && item.length <= limit && item === item.trim() && !/[<>&"'`\u0000-\u001f\u007f]/.test(item);
    const number = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item);
    const only = (item: Record<string, unknown>, keys: string[]) => Object.keys(item).every(key => keys.includes(key));
    if (!object(input) || !only(input, ["schemaVersion", "businessId", "revision", "products", "defaultCostRules"]) || input.schemaVersion !== 1 || input.businessId !== businessId || !text(input.revision, 100)) return null;
    if (!Array.isArray(input.products) || input.products.length > 500 || !Array.isArray(input.defaultCostRules) || !input.defaultCostRules.length || input.defaultCostRules.length > 100) return null;
    for (const p of input.products) {
      if (!object(p) || !only(p, ["type", "brand", "series", "model", "capacityNum", "phase", "nswOnly", "indoorModel", "outdoorModel", "defaultCostCapacityNum", "capacityLabel"])) return null;
      if (!["split", "ducted"].includes(String(p.type)) || !text(p.brand) || !text(p.series) || !text(p.model) || !number(p.capacityNum) || p.capacityNum <= 0 || p.capacityNum > 65 || !["Single", "Three"].includes(String(p.phase))) return null;
      if (p.nswOnly !== undefined && typeof p.nswOnly !== "boolean") return null;
      if (p.defaultCostCapacityNum !== undefined && (!number(p.defaultCostCapacityNum) || p.defaultCostCapacityNum <= 0 || p.defaultCostCapacityNum > 65)) return null;
      for (const key of ["indoorModel", "outdoorModel", "capacityLabel"]) if (p[key] !== undefined && !text(p[key])) return null;
    }
    const legacy: Record<string, [number, number, boolean, boolean]> = {
      lte35: [0, 3.5, true, false], gt35_lt6: [3.5, 6, true, true], gte6: [6, 65, false, false],
      lt10: [0, 10, true, true], eq10: [10, 10, false, false], gt10_lte14: [10, 14, true, false], gt14: [14, 65, true, false],
    };
    const groups: Record<string, [number, number, boolean, boolean][]> = {};
    const ids = new Set();
    for (const r of input.defaultCostRules) {
      if (!object(r) || !only(r, ["id", "system", "install", "range", "rangeLabel", "labour", "materials", "power"])) return null;
      if (!text(r.id, 100) || !/^[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id) || !["split", "ducted"].includes(String(r.system)) || !["new", "replacement"].includes(String(r.install)) || !text(r.rangeLabel)) return null;
      ids.add(r.id);
      for (const key of ["labour", "materials", "power"]) if (!number(r[key]) || r[key] < 0 || r[key] > 10000000) return null;
      let bounds: [number, number, boolean, boolean];
      if (typeof r.range === "string") {
        if (!Object.prototype.hasOwnProperty.call(legacy, r.range)) return null;
        bounds = legacy[r.range];
      } else {
        const range = r.range;
        if (!object(range) || !only(range, ["min", "max", "minExclusive", "maxExclusive"])) return null;
        for (const key of ["min", "max"]) if (range[key] !== undefined && (!number(range[key]) || range[key] < 0 || range[key] > 65)) return null;
        for (const key of ["minExclusive", "maxExclusive"]) if (range[key] !== undefined && (typeof range[key] !== "boolean" || range[key === "minExclusive" ? "min" : "max"] === undefined)) return null;
        bounds = [range.min as number ?? 0, range.max as number ?? 65, range.min === undefined || range.minExclusive === true, range.maxExclusive === true];
        if (bounds[0] > bounds[1] || (bounds[0] === bounds[1] && (bounds[2] || bounds[3]))) return null;
      }
      const key = `${r.system}|${r.install}`;
      (groups[key] ||= []).push(bounds);
    }
    // Every positive capacity through 65kW must match exactly one rule per group.
    for (const system of ["split", "ducted"]) for (const install of ["new", "replacement"]) {
      const intervals = groups[`${system}|${install}`];
      if (!intervals) return null;
      intervals.sort((a, b) => a[0] - b[0] || Number(a[2]) - Number(b[2]) || a[1] - b[1]);
      if (intervals[0][0] !== 0) return null;
      for (let i = 1; i < intervals.length; i++) {
        const previous = intervals[i - 1], current = intervals[i];
        if (previous[1] !== current[0] || previous[3] === current[2]) return null;
      }
      const last = intervals[intervals.length - 1];
      if (last[1] !== 65 || last[3]) return null;
    }
    return input as BusinessCalculatorConfiguration;
  } catch {
    return null;
  }
}

export function withoutBusinessConfiguration(data: Record<string, unknown>) {
  const output = { ...data };
  delete output[BUSINESS_CONFIGURATION_STORAGE_KEY];
  return output;
}

export function validatedBusinessConfigurationData(data: Record<string, unknown>, businessId: string | null | undefined) {
  const output = withoutBusinessConfiguration(data);
  const configuration = validateBusinessCalculatorConfiguration(data[BUSINESS_CONFIGURATION_STORAGE_KEY], businessId);
  if (configuration) output[BUSINESS_CONFIGURATION_STORAGE_KEY] = JSON.stringify(configuration);
  return output;
}

export function revisionGuardedBusinessSnapshot(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
  incomingRevision: unknown,
  businessId: string,
) {
  const output = withoutBusinessConfiguration(incoming);
  const stored = validateBusinessCalculatorConfiguration(existing?.[BUSINESS_CONFIGURATION_STORAGE_KEY], businessId);
  if (!stored) return output;
  if (typeof incomingRevision === "string" && incomingRevision === stored.revision) return output;
  // Old open calculators can save quotes, but cannot roll back this business's import.
  for (const key of ["installerManagedPricesV1", "greenEnergyManagedPricesV1", "ManagedPricesV1", "installerDefaultCostRulesV1", "greenEnergyDefaultCostRulesV1", "DefaultCostRulesV1"]) delete output[key];
  return output;
}
