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
};

export type WonJobValidationResult =
  | { valid: true }
  | {
      valid: false;
      optionId: string;
      optionName: string;
      missingFields: string[];
    };

function recordText(record: StoredRecord, key: string) {
  return String(record[key] || "").trim();
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

  QUOTE_COLLECTION_STORAGE_KEYS.forEach((storageKey) => {
    parseStoredRecords(data[storageKey]).forEach((record, index) => {
      const id = recordText(record, "optionId") || `${storageKey}:row:${recordText(record, "id") || index}`;
      mergeWonJobRecord(jobFor(id), record, "optionName");
    });
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

    if (missingFields.length) {
      return {
        valid: false,
        optionId: candidate.id,
        optionName: candidate.name || "Unnamed quote",
        missingFields,
      };
    }
  }

  return { valid: true };
}

export function wonJobValidationMessage(result: Exclude<WonJobValidationResult, { valid: true }>) {
  return `${result.optionName} cannot be marked as won. Add a Google-verified installation address and a proposed installation date, then try again.`;
}
