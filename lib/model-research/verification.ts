import { originalMatches, requestDetails } from "./registry.mjs";
import { ManufacturerEvidence, mappingMatches } from "./manufacturer.mjs";
import { verifyRequestedModel, type ModelRequestVerificationInput, type ModelRequestVerificationResult } from "../model-request-verification";
import { mergedPublicCatalogue, modelIdentity, readAddedModels } from "../model-catalogue";

export type ResearchJob = {
  id: string;
  external_id: string;
  round: number;
  state: string;
  request: Record<string, unknown>;
  result?: {
    outcome?: string;
    summary?: string;
    question?: string | null;
    canonical?: { brand: string; model: string; systemType: "split" | "ducted"; capacityKw: number; phase: "Single" | "Three"; registrationNumber: string };
    sourceUrls?: string[];
    manufacturerMapping?: { brand: string; model: string; indoor: string; outdoor: string; sourceUrl: string };
  } | null;
};

export async function verifyResearchJob(
  job: ResearchJob,
  getCurrentRequest: (id: string) => Promise<unknown>,
  verify = verifyRequestedModel,
  readCatalogue = async () => mergedPublicCatalogue(await readAddedModels()),
  manufacturer = new ManufacturerEvidence(),
) {
  const isCurrent = async () => {
    const current = await getCurrentRequest(job.external_id);
    return Boolean(current) && JSON.stringify(requestDetails(current)) === JSON.stringify(requestDetails(job.request));
  };
  if (!await isCurrent()) return { kind: "superseded", reason: "Request details changed during research" };
  const evidence: Record<string, unknown> = { research: job.result || {} };
  if (job.state === "waiting_for_details" && job.result?.question) {
    return { kind: "needs_details", question: job.result.question, evidence };
  }
  if (job.state !== "pending_verification" || job.result?.outcome !== "candidate" || !job.result.canonical) {
    if (job.state === "review" && job.result?.outcome === "review") {
      let checked: ModelRequestVerificationResult;
      try { checked = await verify(requestDetails(job.request) as unknown as ModelRequestVerificationInput); }
      catch { return { kind: "retry_verification", reason: "Registry could not be reached to confirm the research outcome." }; }
      if (!await isCurrent()) return { kind: "superseded", reason: "Request details changed during review verification" };
      evidence.verification = { ...checked.evidence, kind: checked.kind };
      const hasRegistry = Boolean(checked.evidence?.registry);
      if (checked.kind === "verified" || checked.kind === "no_rebate") return verifiedOutcome(checked, evidence, readCatalogue);
      if (checked.kind === "clarify" && hasRegistry) return { kind: "needs_details", question: checked.reason, evidence };
      return { kind: "review", reason: checked.kind === "review" || checked.kind === "clarify" ? checked.reason : job.result.summary,
        evidence, registry_match_unverified: checked.evidence?.registryLookup === "no_active_match" };
    }
    return { kind: "review", reason: job.result?.summary || "Research could not complete", evidence,
      registry_match_unverified: false };
  }
  const candidate = job.result.canonical;
  const original = requestDetails(job.request) as unknown as ModelRequestVerificationInput;
  if (candidate.systemType !== original.system_type) return { kind: "review", reason: "Researched system type conflicts with the request", evidence };
  if (!originalMatches(original.model, candidate.model)) {
    const mapping = job.result.manufacturerMapping;
    if (!mappingMatches(mapping, original.model, candidate) || !job.result.sourceUrls?.includes(mapping!.sourceUrl)) {
      return { kind: "review", reason: "No verified manufacturer mapping connects the requested equipment to this registration", evidence, registry_match_unverified: true };
    }
    try { evidence.manufacturerMapping = await manufacturer.verify(mapping); }
    catch (error) {
      if ((error as { code?: string })?.code === "MODEL_MAPPING_NOT_VERIFIED") return {
        kind: "review", reason: "The current manufacturer document no longer confirms the registry mapping", evidence, registry_match_unverified: true,
      };
      return { kind: "retry_verification", reason: "Manufacturer identity evidence could not be rechecked. Retrying without changing the catalogue." };
    }
  }
  const corrected = {
    ...original, brand: candidate.brand, model: candidate.model,
    capacity: String(candidate.capacityKw), phase: candidate.phase.toLowerCase(),
  };
  let verification: ModelRequestVerificationResult;
  try { verification = await verify(corrected); }
  catch { return { kind: "retry_verification", reason: "Registry or certificate service unavailable. This is not a no-rebate result." }; }
  if (!await isCurrent()) return { kind: "superseded", reason: "Request details changed during verification" };
  evidence.verification = { ...verification.evidence, kind: verification.kind };
  if (verification.kind === "clarify") {
    if (verification.evidence?.registryLookup === "no_active_match") return {
      kind: "review", reason: "The researched model no longer has an exact active Australian registry match", evidence, registry_match_unverified: true,
    };
    return { kind: "needs_details", question: verification.reason, evidence };
  }
  if (verification.kind === "review") return { kind: "review", reason: verification.reason, evidence,
    registry_match_unverified: /registrations match|does not confirm a complete|Requested system type|phase is missing|capacity conflicts/.test(verification.reason) };
  const registry = verification.evidence.registry as { registrationNumber?: unknown; brand?: unknown; model?: unknown } | undefined;
  if (registry?.registrationNumber !== candidate.registrationNumber || registry.brand !== candidate.brand || registry.model !== candidate.model) {
    return { kind: "review", reason: "The current registration differs from the researched registration. Reconciliation is required.", evidence, registry_match_unverified: true };
  }
  return verifiedOutcome(verification, evidence, readCatalogue);
}

async function verifiedOutcome(
  verification: Extract<ModelRequestVerificationResult, { kind: "verified" | "no_rebate" }>,
  evidence: Record<string, unknown>,
  readCatalogue: () => Promise<ReturnType<typeof mergedPublicCatalogue>>,
) {
  if (verification.kind === "no_rebate") return {
    kind: "no_rebate", product: verification.product, evidence,
    identity: modelIdentity(verification.product.brand, verification.product.model),
  };
  const product = verification.product;
  const identity = modelIdentity(product.brand, product.model);
  const catalogue = await readCatalogue();
  const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pair = (value: string) => value.split("/").map(compact).sort().join("/");
  const collisions = catalogue.products.filter(item => compact(item.brand) === compact(product.brand) && pair(item.model) === pair(product.model));
  if (collisions.some(item => modelIdentity(item.brand, item.model) !== identity || item.systemType !== product.systemType
    || item.capacityKw !== product.capacityKw || (item.phase || "Single") !== product.phase)) {
    return { kind: "review", reason: "An existing catalogue model has conflicting formatting or specifications.", evidence };
  }
  return { kind: "ready_to_add", product, identity, evidence,
    existing: catalogue.products.some(item => modelIdentity(item.brand, item.model) === identity) };
}
