export type CertificateValues = {
  escRate: number;
  prcRate: number;
  escSpotPrice: number;
  prcSpotPrice: number;
  escAgreementDeduction: number;
  prcAgreementDeduction: number;
  source: string;
  locked: boolean;
  updatedAt: string;
};

export type PlatformCertificateValuesRow = {
  id?: string | null;
  esc_spot_price?: number | string | null;
  prc_spot_price?: number | string | null;
  source?: string | null;
  locked?: boolean | null;
  updated_at?: string | null;
  updated_by_email?: string | null;
};

export const PLATFORM_CERTIFICATE_VALUES_ID = "global";
export const CERTIFICATE_VALUES_STORAGE_KEY = "installerCertificateValuesV1";
export const CERTIFICATE_VALUES_STORAGE_KEYS = [
  CERTIFICATE_VALUES_STORAGE_KEY,
  "greenEnergyCertificateValuesV1",
  "CertificateValuesV1",
];

export const DEFAULT_CERTIFICATE_VALUES: CertificateValues = {
  escRate: 24,
  prcRate: 2.7,
  escSpotPrice: 29,
  prcSpotPrice: 3,
  escAgreementDeduction: 5,
  prcAgreementDeduction: 0.3,
  source: "Electric Future",
  locked: true,
  updatedAt: "",
};

function certificateMoneyValue(value: unknown, fallback: number, allowZero = false) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : fallback;
}

function roundCertificateMoney(value: number) {
  return Number(value.toFixed(2));
}

function certificatePayoutRate(spotPrice: number, agreementDeduction: number) {
  return roundCertificateMoney(Math.max(spotPrice - agreementDeduction, 0));
}

export function normalizeCertificateValues(value: unknown): CertificateValues {
  const saved = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const escSpotPrice = certificateMoneyValue(
    saved.escSpotPrice ?? saved.escSpot ?? saved.escMarketPrice,
    DEFAULT_CERTIFICATE_VALUES.escSpotPrice,
  );
  const prcSpotPrice = certificateMoneyValue(
    saved.prcSpotPrice ?? saved.percSpotPrice ?? saved.prcSpot ?? saved.percSpot,
    DEFAULT_CERTIFICATE_VALUES.prcSpotPrice,
  );
  const escAgreementDeduction = certificateMoneyValue(
    saved.escAgreementDeduction ?? saved.escAgreement ?? saved.escPriceAgreement,
    DEFAULT_CERTIFICATE_VALUES.escAgreementDeduction,
    true,
  );
  const prcAgreementDeduction = certificateMoneyValue(
    saved.prcAgreementDeduction ?? saved.percAgreementDeduction ?? saved.prcAgreement ?? saved.percAgreement,
    DEFAULT_CERTIFICATE_VALUES.prcAgreementDeduction,
    true,
  );

  return {
    escRate: certificatePayoutRate(escSpotPrice, escAgreementDeduction),
    prcRate: certificatePayoutRate(prcSpotPrice, prcAgreementDeduction),
    escSpotPrice,
    prcSpotPrice,
    escAgreementDeduction,
    prcAgreementDeduction,
    source: String(saved.source || DEFAULT_CERTIFICATE_VALUES.source).trim() || DEFAULT_CERTIFICATE_VALUES.source,
    locked: saved.locked === undefined ? DEFAULT_CERTIFICATE_VALUES.locked : Boolean(saved.locked),
    updatedAt: String(saved.updatedAt || ""),
  };
}

export function certificateValuesFromStoredData(
  data: Record<string, unknown> | null | undefined,
) {
  if (!data) return null;

  for (const key of CERTIFICATE_VALUES_STORAGE_KEYS) {
    const raw = data[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string") {
      try {
        return normalizeCertificateValues(JSON.parse(raw));
      } catch {
        continue;
      }
    }
    return normalizeCertificateValues(raw);
  }

  return null;
}

export function serializeCertificateValues(values: CertificateValues) {
  return JSON.stringify({
    escRate: roundCertificateMoney(values.escRate),
    prcRate: roundCertificateMoney(values.prcRate),
    escSpotPrice: roundCertificateMoney(values.escSpotPrice),
    prcSpotPrice: roundCertificateMoney(values.prcSpotPrice),
    escAgreementDeduction: roundCertificateMoney(values.escAgreementDeduction),
    prcAgreementDeduction: roundCertificateMoney(values.prcAgreementDeduction),
    source: values.source,
    locked: values.locked,
    updatedAt: values.updatedAt,
  });
}

export function dataWithCertificateValues(
  data: Record<string, unknown>,
  values: CertificateValues,
) {
  const next = { ...data };
  CERTIFICATE_VALUES_STORAGE_KEYS.forEach((key) => {
    delete next[key];
  });
  next[CERTIFICATE_VALUES_STORAGE_KEY] = serializeCertificateValues(values);
  return next;
}

export function certificateValuesForBusiness(
  platformValues: CertificateValues,
  agreementSource: Partial<CertificateValues> | null | undefined,
) {
  return normalizeCertificateValues({
    escSpotPrice: platformValues.escSpotPrice,
    prcSpotPrice: platformValues.prcSpotPrice,
    escAgreementDeduction:
      agreementSource?.escAgreementDeduction ?? DEFAULT_CERTIFICATE_VALUES.escAgreementDeduction,
    prcAgreementDeduction:
      agreementSource?.prcAgreementDeduction ?? DEFAULT_CERTIFICATE_VALUES.prcAgreementDeduction,
    source: platformValues.source,
    locked: platformValues.locked,
    updatedAt: platformValues.updatedAt,
  });
}

export function platformCertificateValuesFromRow(
  row: PlatformCertificateValuesRow | null | undefined,
) {
  if (!row) return null;
  return normalizeCertificateValues({
    escSpotPrice: row.esc_spot_price,
    prcSpotPrice: row.prc_spot_price,
    source: row.source,
    locked: row.locked,
    updatedAt: row.updated_at,
  });
}

export function platformCertificateValuesPayload(
  values: CertificateValues,
  updatedByEmail: string,
) {
  return {
    id: PLATFORM_CERTIFICATE_VALUES_ID,
    esc_spot_price: roundCertificateMoney(values.escSpotPrice),
    prc_spot_price: roundCertificateMoney(values.prcSpotPrice),
    source: values.source,
    locked: values.locked,
    updated_at: values.updatedAt,
    updated_by_email: updatedByEmail,
  };
}

export function certificatePlatformFieldsMatch(
  actual: CertificateValues | null | undefined,
  expected: CertificateValues,
) {
  const actualUpdatedAt = Date.parse(String(actual?.updatedAt || ""));
  const expectedUpdatedAt = Date.parse(String(expected.updatedAt || ""));
  const updatedAtMatches = Number.isFinite(actualUpdatedAt) && Number.isFinite(expectedUpdatedAt)
    ? actualUpdatedAt === expectedUpdatedAt
    : String(actual?.updatedAt || "") === String(expected.updatedAt || "");

  return Boolean(
    actual
      && roundCertificateMoney(actual.escSpotPrice) === roundCertificateMoney(expected.escSpotPrice)
      && roundCertificateMoney(actual.prcSpotPrice) === roundCertificateMoney(expected.prcSpotPrice)
      && actual.source === expected.source
      && actual.locked === expected.locked
      && updatedAtMatches,
  );
}

export function overlayPlatformCertificateValues(
  businessData: Record<string, unknown>,
  platformValues: CertificateValues | null | undefined,
) {
  if (!platformValues) return businessData;
  const agreement = certificateValuesFromStoredData(businessData) || DEFAULT_CERTIFICATE_VALUES;
  return dataWithCertificateValues(
    businessData,
    certificateValuesForBusiness(platformValues, agreement),
  );
}
