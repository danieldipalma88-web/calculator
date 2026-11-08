import { requestDetails } from "./registry.mjs";
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
  } | null;
};

export async function verifyResearchJob(
  job: ResearchJob,
  getCurrentRequest: (id: string) => Promise<unknown>,
  verify = verifyRequestedModel,
  readCatalogue = async () => mergedPublicCatalogue(await readAddedModels()),
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
    return { kind: "review", reason: job.result?.summary || "Research needs administrator review", evidence };
  }
  const candidate = job.result.canonical;
  const original = requestDetails(job.request) as unknown as ModelRequestVerificationInput;
  if (candidate.systemType !== original.system_type) return { kind: "review", reason: "Researched system type conflicts with the request", evidence };
  const corrected = {
    ...original, brand: candidate.brand, model: candidate.model,
    capacity: String(candidate.capacityKw), phase: candidate.phase.toLowerCase(),
  };
  let verification: ModelRequestVerificationResult;
  try { verification = await verify(corrected); }
  catch { return { kind: "retry_verification", reason: "Registry or certificate service unavailable. This is not a no-rebate result." }; }
  if (!await isCurrent()) return { kind: "superseded", reason: "Request details changed during verification" };
  evidence.verification = { ...verification.evidence, kind: verification.kind };
  if (verification.kind === "clarify") return { kind: "needs_details", question: verification.reason, evidence };
  if (verification.kind === "review") return { kind: "review", reason: verification.reason, evidence };
  const registry = verification.evidence.registry as { registrationNumber?: unknown; brand?: unknown; model?: unknown } | undefined;
  if (registry?.registrationNumber !== candidate.registrationNumber || registry.brand !== candidate.brand || registry.model !== candidate.model) {
    return { kind: "review", reason: "The current registration differs from the researched registration. Reconciliation is required.", evidence };
  }
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
