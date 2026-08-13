const OPTION_COLLECTION_STORAGE_KEYS = [
  "installerQuoteOptionDefsV1",
  "greenEnergyQuoteOptionDefsV1",
  "QuoteOptionDefsV1",
];

const QUOTE_COLLECTION_STORAGE_KEYS = [
  "installerMasterQuoteLogV1",
  "greenEnergyMasterQuoteLogV1",
  "MasterQuoteLogV1",
];

type StoredRecord = Record<string, unknown>;

type WonJobSnapshot = {
  id: string;
  name: string;
  wonAt: string;
  installationAddress: string;
  googlePlaceId: string;
  proposedInstallationDate: string;
  quoteRowCount: number;
  missingPriceModels: string[];
};

export type WonJobValidationResult =
  | { valid: true }
  | {
      valid: false;
      optionId: string;
      optionName: string;
      missingFields: string[];
      missingPriceModels: string[];
    };

function recordText(record: StoredRecord, key: string) {
  return String(record[key] || "").trim();
}

function recordObject(record: StoredRecord, key: string) {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StoredRecord
    : {};
}

function positivePrice(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function recordVersion(record: StoredRecord) {
  const direct = Number(record.syncUpdatedAt ?? record.timestamp);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(recordText(record, "wonAt"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteRowMissingPriceModels(record: StoredRecord) {
  const state = recordObject(record, "state");
  const type = `${recordText(record, "type")} ${recordText(state, "systemType")}`.toLowerCase();
  const isMultiHead = type.includes("multi-head") || type.includes("multi_split");
  const rowModel = recordText(record, "model") || recordText(state, "model") || "selected unit";

  if (!isMultiHead) {
    return positivePrice(record.unitInc ?? state.unitPriceInc) ? [] : [rowModel];
  }

  const missing: string[] = [];
  const rawHeads = state.indoorHeads;
  const heads = Array.isArray(rawHeads)
    ? rawHeads.filter((head): head is StoredRecord => !!head && typeof head === "object" && !Array.isArray(head))
    : [];
  let pricedIndoorTotal = 0;

  heads.forEach((head) => {
    const quantity = Math.max(1, Math.floor(Number(head.qty) || 1));
    if (positivePrice(head.unitPriceInc)) {
      pricedIndoorTotal += Number(head.unitPriceInc) * quantity;
    } else {
      missing.push(recordText(head, "model") || "selected indoor unit");
    }
  });

  let outdoorPrice = Number(state.outdoorUnitPriceInc);
  if (!Number.isFinite(outdoorPrice)) {
    const total = Number(record.unitInc ?? state.unitPriceInc);
    outdoorPrice = Number.isFinite(total) ? total - pricedIndoorTotal : 0;
  }
  if (!positivePrice(outdoorPrice)) {
    missing.push(recordText(state, "outdoorModel") || recordText(state, "model") || rowModel);
  }
  if (!heads.length && !positivePrice(record.unitInc ?? state.unitPriceInc)) {
    missing.push(rowModel);
  }

  return [...new Set(missing)];
}

function parseStoredRecords(value: unknown) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [] as StoredRecord[];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is StoredRecord => !!entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function calculatorDataObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mergeWonJobRecord(target: WonJobSnapshot, record: StoredRecord, nameKey: "name" | "optionName") {
  target.name ||= recordText(record, nameKey);
  target.wonAt ||= recordText(record, "wonAt");
  target.installationAddress ||= recordText(record, "installationAddress");
  target.googlePlaceId ||= recordText(record, "googlePlaceId");
  target.proposedInstallationDate ||= recordText(record, "proposedInstallationDate");
}

function wonJobsFromCalculatorData(value: unknown) {
  const data = calculatorDataObject(value);
  const jobs = new Map<string, WonJobSnapshot>();

  function jobFor(id: string) {
    const existing = jobs.get(id);
    if (existing) return existing;
    const created: WonJobSnapshot = {
      id,
      name: "",
      wonAt: "",
      installationAddress: "",
      googlePlaceId: "",
      proposedInstallationDate: "",
      quoteRowCount: 0,
      missingPriceModels: [],
    };
    jobs.set(id, created);
    return created;
  }

  OPTION_COLLECTION_STORAGE_KEYS.forEach((storageKey) => {
    parseStoredRecords(data[storageKey]).forEach((record, index) => {
      const id = recordText(record, "id") || `${storageKey}:option:${index}`;
      mergeWonJobRecord(jobFor(id), record, "name");
    });
  });

  const latestQuoteRows = new Map<string, StoredRecord>();
  QUOTE_COLLECTION_STORAGE_KEYS.forEach((storageKey) => {
    parseStoredRecords(data[storageKey]).forEach((record, index) => {
      const rowId = recordText(record, "id") || `${storageKey}:row:${index}`;
      const existing = latestQuoteRows.get(rowId);
      if (!existing || recordVersion(record) >= recordVersion(existing)) {
        latestQuoteRows.set(rowId, record);
      }
    });
  });
  latestQuoteRows.forEach((record, rowId) => {
    const id = recordText(record, "optionId") || `row:${rowId}`;
    const job = jobFor(id);
    mergeWonJobRecord(job, record, "optionName");
    job.quoteRowCount += 1;
    job.missingPriceModels.push(...quoteRowMissingPriceModels(record));
    job.missingPriceModels = [...new Set(job.missingPriceModels)];
  });

  return jobs;
}

function isValidInstallationDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function validateNewWonJobTransitions(
  existingData: unknown,
  candidateData: unknown,
): WonJobValidationResult {
  const existingJobs = wonJobsFromCalculatorData(existingData);
  const candidateJobs = wonJobsFromCalculatorData(candidateData);

  for (const candidate of candidateJobs.values()) {
    const existingWonAt = existingJobs.get(candidate.id)?.wonAt;
    if (!candidate.wonAt || candidate.wonAt === existingWonAt) continue;

    const missingFields: string[] = [];
    if (!candidate.installationAddress) missingFields.push("installation address");
    if (!candidate.googlePlaceId) missingFields.push("Google-verified address");
    if (!isValidInstallationDate(candidate.proposedInstallationDate)) {
      missingFields.push("proposed installation date");
    }
    const missingPriceModels = candidate.quoteRowCount > 0
      ? candidate.missingPriceModels
      : [];

    if (missingFields.length || missingPriceModels.length) {
      return {
        valid: false,
        optionId: candidate.id,
        optionName: candidate.name || "Unnamed quote",
        missingFields,
        missingPriceModels,
      };
    }
  }

  return { valid: true };
}

export function wonJobValidationMessage(result: Exclude<WonJobValidationResult, { valid: true }>) {
  const requirements: string[] = [];
  if (result.missingFields.length) {
    requirements.push("Add a Google-verified installation address and a proposed installation date.");
  }
  if (result.missingPriceModels.length) {
    requirements.push(`Add a unit price for ${result.missingPriceModels.join(", ")}.`);
  }
  return `${result.optionName} cannot be marked as won. ${requirements.join(" ")} Then try again.`;
}
