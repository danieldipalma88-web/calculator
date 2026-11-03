type SystemPrice = {
  catalogue: "default" | "andos";
  type: "split" | "ducted";
  brand: string;
  model: string;
  phase: "Single" | "Three";
  managedKey: string;
  price: number;
};

type MultiPrice = {
  kind: "outdoor" | "indoor";
  brand: string;
  model: string;
  registryOnly: boolean;
  price: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function identityPart(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 180 && !/[|<>\x00-\x1f]/.test(value);
}

function validCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseAadCataloguePriceDefaults(raw: string | undefined): { systems: SystemPrice[]; multi: MultiPrice[] } | null {
  if (!raw || raw.length > 60_000) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!record(data) || !Array.isArray(data.systems) || !Array.isArray(data.multi)) return null;
    const systems: SystemPrice[] = [];
    const multi: MultiPrice[] = [];
    const keys = new Set<string>();
    const addKey = (...parts: string[]) => {
      const key = JSON.stringify(parts.map((s) => s.toUpperCase().replace(/\s+/g, "")));
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    };
    for (const row of data.systems) {
      if (!record(row)) return null;
      const { catalogue, type, brand, model, phase, managedKey, incGstCents } = row;
      const prefix = catalogue === "andos" ? `andos|${type}|` : `${type}|`;
      if ((catalogue !== "default" && catalogue !== "andos") || (type !== "split" && type !== "ducted")
        || !identityPart(brand) || !identityPart(model) || (phase !== "Single" && phase !== "Three")
        || typeof managedKey !== "string" || !managedKey.startsWith(prefix) || !/^\d+$/.test(managedKey.slice(prefix.length))
        || !validCents(incGstCents) || !addKey(catalogue, type, brand, model, phase) || !addKey("key", managedKey)) return null;
      systems.push({ catalogue, type, brand, model, phase, managedKey, price: incGstCents / 100 });
    }
    for (const row of data.multi) {
      if (!record(row)) return null;
      const { kind, brand, model, registryOnly, incGstCents } = row;
      if ((kind !== "outdoor" && kind !== "indoor") || !identityPart(brand) || !identityPart(model)
        || typeof registryOnly !== "boolean" || (registryOnly && kind !== "outdoor")
        || !validCents(incGstCents) || !addKey(kind, brand, model)) return null;
      multi.push({ kind, brand, model, registryOnly, price: incGstCents / 100 });
    }
    return { systems, multi };
  } catch {
    return null;
  }
}

const managedPriceKeys = ["installerManagedPricesV1", "greenEnergyManagedPricesV1", "ManagedPricesV1"];
const code = (s: unknown) => typeof s === "string" ? s.toUpperCase().replace(/\s+/g, "") : "";
const compact = (s: string) => code(s).replace(/[^A-Z0-9]/g, "");
function numericPrice(value: unknown) {
  return (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value)) && Number(value) > 0
    ? Number(value) : 0;
}

function storedPrices(value: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function preserveAadTargetPrices(
  existing: unknown,
  incoming: Record<string, unknown>,
  defaults: ReturnType<typeof parseAadCataloguePriceDefaults>,
  edits: unknown,
): { data: Record<string, unknown>; conflict: boolean } {
  if (!defaults) return { data: incoming, conflict: false };
  const original = record(existing) ? existing : {};
  const intents = record(edits) ? edits : {};
  const indexed = new Map(defaults.systems.map((row) => [row.managedKey, row]));
  const systems = new Set(defaults.systems.map((row) => `${row.catalogue}|${row.type}|${code(row.model)}`));
  const legacySystems = new Set(defaults.systems.map((row) => code(
    `${row.catalogue === "andos" ? "andos|" : ""}${row.type}|${row.brand}|${row.model}`)));
  const multi = new Set(defaults.multi.map((row) => `multi-${row.kind}|${compact(row.brand)}|${compact(row.model)}`));
  const protects = (key: string, value: Record<string, unknown> | null) => {
    if (multi.has(key) || legacySystems.has(code(key))) return true;
    const row = indexed.get(key);
    if (row && (!value?.model || code(value.model) === code(row.model))) return true;
    const parts = key.split("|");
    if (parts[0] === "andos") return systems.has(`andos|${parts[1]}|${code(value?.model)}`);
    return systems.has(`default|${parts[0]}|${code(value?.model)}`);
  };
  const output = { ...incoming };
  for (const alias of managedPriceKeys) {
    if (!Object.hasOwn(incoming, alias)) continue;
    const previous = storedPrices(original[alias]) ?? {};
    const next = storedPrices(incoming[alias]);
    const guarded = { ...next };
    let changed = false;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(guarded)])) {
      const prior = Object.hasOwn(previous, key) && record(previous[key]) ? previous[key] : null;
      const candidate = Object.hasOwn(guarded, key) ? guarded[key] : null;
      const proposed = record(candidate) ? candidate : null;
      if (!protects(key, prior) && !protects(key, proposed)) continue;
      const before = numericPrice(prior?.unitPriceInc);
      const after = numericPrice(proposed?.unitPriceInc);
      if (before === after && !(prior && !proposed && before > 0)) continue;
      const intent = alias === managedPriceKeys[0] && Object.hasOwn(intents, key) && record(intents[key]) ? intents[key] : null;
      if (intent && typeof intent.before === "number" && typeof intent.after === "number" && intent.after === after) {
        if (intent.before !== before) return { data: incoming, conflict: true };
        if (!proposed && prior && before > 0) {
          // A zero entry survives the generic snapshot merge's empty-map protection.
          guarded[key] = { ...prior, unitPriceInc: 0 };
          changed = true;
        }
        continue;
      }
      // Ordinary snapshots can carry stale prices; only an explicit edit changes the equipment cost.
      if (!prior && !proposed) continue;
      if (!prior) delete guarded[key];
      else guarded[key] = proposed && (!prior.model || code(proposed.model) === code(prior.model))
        ? { ...proposed, unitPriceInc: prior.unitPriceInc }
        : prior;
      changed = true;
    }
    if (changed) output[alias] = typeof incoming[alias] === "string" ? JSON.stringify(guarded) : guarded;
  }
  return { data: output, conflict: false };
}
