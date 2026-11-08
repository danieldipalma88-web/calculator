import { catalogueClient } from "../model-catalogue";

type RpcClient = Pick<ReturnType<typeof catalogueClient>, "rpc">;
export type ResearchRequest = {
  id: string; round: number; brand: string; model: string; capacity: string;
  phase: string; postcode: string; install_type: string; system_type: string;
  notes: string; messages: string[];
};
export type ResearchJob = {
  id: string; external_id: string; round: number; fingerprint: string;
  request: ResearchRequest; state: string; lease: string | null;
  lease_until: string | null; checkpoint: Record<string, any> | null;
  result: Record<string, any> | null; created_at: string; updated_at: string;
  applied_at: string | null; applied_outcome: Record<string, any> | null;
  events: { at: string; kind: string; detail: string }[];
};

// The database owns time, snapshots, leases and money. now() stays synchronous
// because the research core uses it for local pricing/registry validation.
export class PostgresResearchStore {
  readonly now: () => Date;
  private readonly client: RpcClient;
  private readonly secret: string;

  constructor(secret = process.env.MODEL_REQUEST_WORKER_SECRET || "", client?: RpcClient, now = () => new Date()) {
    if (secret.length < 40) throw new Error("Model research worker secret is not configured");
    this.secret = secret;
    this.client = client || catalogueClient();
    this.now = now;
  }

  async rpc(action: string, id?: string | null, lease?: string | null, data: unknown = {}): Promise<any> {
    const result = await this.client.rpc("model_request_research_worker", {
      p_secret: this.secret, p_action: action, p_id: id || null,
      p_lease: lease || null, p_data: data,
    });
    // Do not include RPC bodies, provider input, credentials or SQL details.
    if (result.error) {
      if (action === "reserve" && result.error.message?.startsWith("Monthly research budget cannot cover")) {
        throw new Error("Monthly research budget cannot cover another bounded API call");
      }
      throw new Error(`Model research ${action} failed: ${result.error.code || "database_error"}`);
    }
    return result.data;
  }

  call(action: string, id?: string | null, lease?: string | null, data: unknown = {}) {
    return this.rpc(action, id, lease, data);
  }
  enqueue(requestId?: string): Promise<ResearchJob | null> { return this.rpc("enqueue", requestId); }
  get(jobId: string): Promise<ResearchJob | null> { return this.rpc("get", jobId); }
  current(externalId: string): Promise<ResearchRequest | null> { return this.rpc("current", externalId); }
  claim(jobId?: string): Promise<{ job: ResearchJob; lease: string } | null> { return this.rpc("claim", jobId); }
  async checkLease(id: string, lease: string): Promise<void> { await this.rpc("check_lease", id, lease); }
  async checkpoint(id: string, lease: string, data: unknown): Promise<void> { await this.rpc("checkpoint", id, lease, data); }
  async finish(id: string, lease: string, state: string, result: unknown): Promise<void> {
    await this.rpc("finish", id, lease, { state, result });
  }
  async event(id: string, kind: string, detail: unknown): Promise<void> {
    await this.rpc("event", id, null, { kind, detail: String(detail).slice(0, 2400) });
  }
  related(identity: string, id: string): Promise<string[]> { return this.rpc("related", id, null, { identity }); }
  reserve(id: string, lease: string, micros: number, limit: number): Promise<string> {
    return this.rpc("reserve", id, lease, { micros, limit });
  }
  settle(costId: string, charge: number, providerId: string): Promise<boolean> {
    return this.rpc("settle", costId, null, { charge, provider_id: providerId });
  }
  async rejected(costId: string): Promise<void> { await this.rpc("rejected", costId); }
  async uncertain(costId: string): Promise<void> { await this.rpc("uncertain", costId); }
  budget(_month?: string): Promise<{
    month: string; charged: number; reserved: number; spentMicros: number;
    reservedMicros: number; limitMicros: number; pricingReviewBy: string;
  }> { return this.rpc("budget"); }
  async yield(id: string, lease: string): Promise<void> { await this.rpc("yield", id, lease); }
  apply(jobId: string, outcome: unknown) { return this.rpc("apply_result", jobId, null, { outcome }); }
  confirmationClaim(externalId?: string) { return this.rpc("confirmation_claim", externalId); }
}
