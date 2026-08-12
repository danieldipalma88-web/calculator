import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, guidanceRoute, requestRoute, sessionHelper, migration] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app/api/calculator-guidance/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/model-requests/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/supabase/approved-calculator-session.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/calculator_guidance_and_model_requests_upgrade.sql", import.meta.url), "utf8"),
]);

assert.match(html, /id="calculatorGuidanceModal"[\s\S]*id="calculatorGuidanceAccepted"[\s\S]*id="calculatorGuidanceContinue"[^>]*disabled/);
assert.match(html, /rebate amounts and preloaded costs are estimates, may change, and should be verified/i);
assert.match(html, /setTimeout\(initializeCalculatorGuidance,500\);/);
assert.doesNotMatch(html, /id="calculatorGuidanceModal"[^>]*onclick=/, "the required notice must not close from a backdrop click");
assert.match(html, /Can't find your system\? Request a model/g);
assert.match(html, /openModelRequestModal\('standard'\)/);
assert.match(html, /openModelRequestModal\('multi'\)/);
assert.match(html, /clientRequestId:modelRequestClientId/);
assert.match(html, /businessId:user\.businessId/);

assert.match(sessionHelper, /supabase\.auth\.getUser\(\)/);
assert.match(sessionHelper, /approved_users/);
assert.match(sessionHelper, /is_locked/);
assert.match(guidanceRoute, /quote_calculator_estimates_notice/);
assert.match(guidanceRoute, /calculator_user_acknowledgements/);
assert.match(guidanceRoute, /body\?\.accepted !== true/);

assert.match(requestRoute, /approved_user_businesses/);
assert.match(requestRoute, /REQUEST_LIMIT = 5/);
assert.match(requestRoute, /\.eq\("client_request_id", clientRequestId\)/);
assert.match(requestRoute, /RESEND_API_KEY/);
assert.match(requestRoute, /daniel@electric-future\.com/);
const insertAt = requestRoute.indexOf('.from("calculator_model_requests")\n    .insert');
const emailAt = requestRoute.indexOf("await sendModelRequestEmail");
assert.ok(insertAt >= 0 && emailAt > insertAt, "model request must be stored before email is attempted");

assert.match(migration, /alter table public\.calculator_user_acknowledgements enable row level security/i);
assert.match(migration, /alter table public\.calculator_model_requests enable row level security/i);
assert.match(migration, /unique \(user_id, client_request_id\)/i);
assert.match(migration, /\(select auth\.uid\(\)\) = user_id/i);
assert.match(migration, /revoke all on table public\.calculator_model_requests from anon/i);

console.log("Calculator guidance and missing-model request safeguards verified.");
