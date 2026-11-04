import Link from "next/link";
import { getApprovedCalculatorSession } from "../../../lib/supabase/approved-calculator-session";
import RequestResponse from "../request-response";
import styles from "../model-requests.module.css";

type RequestData = {
  brand: string;
  model: string;
  system_type: string;
  postcode: string;
  install_type: string;
  state: "waiting" | "closed" | "escalated" | "queued" | "checking" | "review" | "added" | "declined";
  question: string;
  candidates: string[];
  next_at: string | null;
  round: number | null;
  product?: { model: string };
};

const stateLabels: Record<RequestData["state"], string> = {
  waiting: "Waiting for your response",
  closed: "Request closed",
  escalated: "Referred for human review",
  queued: "Response received",
  checking: "Being checked",
  review: "Under review",
  added: "Model added",
  declined: "Request declined",
};

export default async function ModelRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const approval = await getApprovedCalculatorSession();
  if (approval.status === 401) {
    const next = `/model-requests/${encodeURIComponent(id)}`;
    return <main className={styles.shell}><section className={styles.panel}>
      <p className={styles.eyebrow}>Rebate Portal</p><h1>Respond to model request</h1>
      <p>Sign in with your approved calculator account to view and respond to this request.</p>
      <Link className={styles.primaryLink} href={`/?next=${encodeURIComponent(next)}`}>Sign in</Link>
    </section></main>;
  }
  if (approval.status !== 200) {
    return <main className={styles.shell}><section className={styles.panel}>
      <p className={styles.eyebrow}>Rebate Portal</p><h1>Request unavailable</h1><p>{approval.error}</p>
      <Link className={styles.secondaryLink} href="/">Sign-in page</Link>
    </section></main>;
  }

  const { data, error } = await approval.session.supabase.rpc("model_request_self", {
    p_id: id,
    p_response: null,
  });
  if (error || !data) {
    return <main className={styles.shell}><section className={styles.panel}>
      <p className={styles.eyebrow}>Rebate Portal</p><h1>Request unavailable</h1>
      <p>This request could not be found for your account.</p>
    </section></main>;
  }

  const request = data as RequestData;
  return <main className={styles.shell}>
    <section className={styles.panel}>
      <p className={styles.eyebrow}>Rebate Portal / Model request</p>
      <h1>{request.brand} {request.model}</h1>
      <dl className={styles.facts}>
        <div><dt>System</dt><dd>{request.system_type}</dd></div>
        <div><dt>Request status</dt><dd>{stateLabels[request.state] || "Request status"}</dd></div>
        {request.product?.model ? <div><dt>Added model</dt><dd>{request.product.model}</dd></div> : null}
      </dl>
      <RequestResponse id={id} request={request} />
    </section>
  </main>;
}
