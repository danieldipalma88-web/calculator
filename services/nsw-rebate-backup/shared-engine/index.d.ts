// SPDX-License-Identifier: AGPL-3.0-only
// Standalone AGPL service only. See ../LICENSE and ./README.md.

/** Canonical UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ, validated at runtime. */
export type UtcInstant = string;
export type Installation = 'new' | 'replacement';
export type EssClimateZone = 'hot' | 'mixed' | 'cold';
export type BcaClimateZone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type CoverageRelease = 'atlas-20261106t113910611z-3756476b802a';

export interface Freshness {
  readonly observedAt: UtcInstant;
  /** Exclusive; no more than seven days after observedAt. */
  readonly validUntil: UtcInstant;
}

export interface GemsRegistration extends Freshness {
  readonly number: string;
  readonly market: 'AU';
  readonly status: 'active';
  readonly resourceId: 'd4e17a35-9002-4a0c-ac1c-003ece0de135';
  readonly snapshotSha256: string;
  /** Exclusive registration cutoff, normalized by the trusted adapter. */
  readonly registrationValidUntil: UtcInstant;
}

export interface EnergyRatings {
  readonly coolingCapacityKw: number;
  readonly heatingCapacityKw: number;
  readonly coolingInputKw: number;
  readonly ratedAeer: number;
  readonly ratedAcop: number;
  readonly tcspfMixed: number;
  readonly hspfMixed: number;
  readonly hspfCold: number;
  readonly annualEnergy: Readonly<Record<EssClimateZone, Readonly<{ coolingKwh: number; heatingKwh: number }>>>;
}

export type EquipmentConfiguration =
  | { readonly productClass: 8; readonly systemType: 'split' }
  | { readonly productClass: 10; readonly systemType: 'ducted' };

export type Equipment = EquipmentConfiguration & {
  readonly brand: string;
  readonly model: string;
  readonly phase: 'single';
  readonly cycle: 'reverse-cycle';
  readonly indoorHeadCount: 1;
  readonly registration: GemsRegistration;
  readonly ratings: EnergyRatings;
};

export interface VerifiedEnvironment extends Freshness {
  readonly jurisdiction: 'NSW';
  readonly postcode: string;
  readonly essClimateZone: EssClimateZone;
  readonly bcaClimateZone: BcaClimateZone;
  readonly coverageRelease: CoverageRelease;
}

/** Trusted adapter input only. This type does not attest to its authenticity. */
export interface CertificateInput {
  readonly schemaVersion: 1;
  readonly asOf: UtcInstant;
  readonly installation: Installation;
  readonly equipment: Equipment;
  readonly environment: VerifiedEnvironment;
}

export interface CertificateCounts {
  readonly esc: number;
  readonly prc: number;
}

export interface CalculatedCertificates {
  readonly status: 'calculated';
  readonly schemaVersion: 1;
  readonly counts: CertificateCounts;
  /** Equipment efficiency checks only, not a determination of scheme eligibility. */
  readonly eligibility: Readonly<{ esc: boolean; prc: boolean }>;
  readonly context: EquipmentConfiguration & {
    readonly asOf: UtcInstant;
    readonly installation: Installation;
    readonly brand: string;
    readonly model: string;
    readonly postcode: string;
    readonly essClimateZone: EssClimateZone;
    readonly bcaClimateZone: BcaClimateZone;
  };
  readonly provenance: Readonly<{
    rule: Readonly<{
      scheme: 'NSW-residential-HVAC1_PDRSAug24';
      revision: 'ae8d778f18e0612bd38c69a2527ff9d7e12d3747';
      source: string;
      sourcePeriod: '2021-01-01';
    }>;
    gems: GemsRegistration;
    environment: Pick<VerifiedEnvironment, 'coverageRelease' | 'observedAt' | 'validUntil'>;
    validUntil: UtcInstant;
    publisherAuthenticated: false;
  }>;
}

export type UnsupportedCode = 'invalid-input' | 'unsupported-schema' | 'unsupported-installation'
  | 'unsupported-equipment' | 'unsupported-registration' | 'invalid-provenance' | 'expired-data'
  | 'unsupported-postcode' | 'environment-mismatch' | 'invalid-rating' | 'negative-savings' | 'calculation-error';

export interface UnsupportedCertificates<Code = UnsupportedCode> {
  readonly status: 'unsupported';
  readonly code: Code;
  readonly field?: string;
}

export type CertificateResult = CalculatedCertificates | UnsupportedCertificates;

export type ShadowResult = UnsupportedCertificates<UnsupportedCode | 'invalid-authoritative'> | {
  readonly status: 'match' | 'mismatch';
  readonly tolerance: 0.0002;
  readonly candidate: CalculatedCertificates;
  /** Candidate minus authoritative, signed per scheme. */
  readonly delta: CertificateCounts;
};

export function calculateSharedCertificates(input: CertificateInput): CertificateResult;
export function compareCertificateShadow(input: CertificateInput, authoritative: CertificateCounts): ShadowResult;
