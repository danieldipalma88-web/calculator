import { catalogueClient, mergedPublicCatalogue, modelIdentity, readAddedModels } from "./model-catalogue";
import { verifyRequestedModel } from "./model-request-verification";
import { sendModelRequestConfirmation } from "./model-request-email";

export function modelAutomationEnabled() {
  return process.env.MODEL_REQUEST_AUTOMATION_ENABLED === "true" && Boolean(process.env.MODEL_REQUEST_WORKER_SECRET);
}

export async function processModelRequest(requestId?: string) {
  if (!modelAutomationEnabled()) return { processed: false };
  const client = catalogueClient();
  const rpc = async (action: string, id?: string, lease?: string, data: unknown = {}) => {
    const result = await client.rpc("model_request_worker", {
      p_secret: process.env.MODEL_REQUEST_WORKER_SECRET,
      p_action: action, p_id: id || null, p_lease: lease || null, p_data: data,
    });
    if (result.error) throw new Error(`Model request ${action} failed: ${result.error.code}`);
    return result.data;
  };
  const claimed = await rpc("claim", requestId);
  if (!claimed) return { processed: false };
  const { request, job } = claimed;
  const id = request.id as string;
  const lease = job.lease_token as string;
  let resultJob = job;
  if (job.state !== "added") {
    try {
      if (!claimed.user_enabled || claimed.operating_state !== "NSW") {
        await rpc("review", id, lease, { reason: "Automatic additions require an active approved user and NSW business." });
        return { processed: true, state: "review" };
      }
      const result = await verifyRequestedModel(request);
      if (result.kind === "review") {
        await rpc("review", id, lease, result);
        return { processed: true, state: "review" };
      }
      const identity = modelIdentity(result.product.brand, result.product.model);
      const current = mergedPublicCatalogue(await readAddedModels());
      const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const collisions = current.products.filter(p => compact(p.brand) === compact(result.product.brand)
        && p.model.split('/').map(compact).sort().join('/') === result.product.model.split('/').map(compact).sort().join('/'));
      if (collisions.some(p => modelIdentity(p.brand, p.model) !== identity || p.systemType !== result.product.systemType
        || p.capacityKw !== result.product.capacityKw || (p.phase || 'Single') !== result.product.phase)) {
        await rpc("review", id, lease, { reason: "An existing catalogue entry has conflicting model formatting or specifications. Please reconcile before adding.", evidence: result.evidence });
        return { processed: true, state: "review" };
      }
      const existing = current.products.some(p => modelIdentity(p.brand, p.model) === identity);
      resultJob = await rpc("verified", id, lease, { ...result, identity, existing });
      if (resultJob.state !== "added") return { processed: true, state: resultJob.state };
    } catch (error) {
      await rpc("retry", id, lease, { reason: error instanceof Error ? error.message.slice(0, 500) : "Verification temporarily unavailable" });
      return { processed: true, state: "retry" };
    }
  }
  try {
    const published = await readAddedModels();
    if (!published.some(p => modelIdentity(p.product.brand, p.product.model) === modelIdentity(resultJob.product.brand, resultJob.product.model))) {
      throw new Error("Model is no longer published. Confirmation held for review.");
    }
    await rpc("email_start", id, lease);
    const emailId = await sendModelRequestConfirmation({
      requestId: id, recipient: request.requester_email,
      brand: resultJob.product.brand, model: resultJob.product.model,
      systemType: resultJob.product.systemType, existing: resultJob.existing,
    });
    await rpc("email_sent", id, lease, { id: emailId });
    return { processed: true, state: "added" };
  } catch (error) {
    await rpc("email_error", id, lease, { reason: error instanceof Error ? error.message.slice(0, 500) : "Email temporarily unavailable" });
    return { processed: true, state: "email_pending" };
  }
}
