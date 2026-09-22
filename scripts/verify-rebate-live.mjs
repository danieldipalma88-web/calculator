import assert from "node:assert/strict";
import crypto from "node:crypto";
import { LIVE_ORIGIN, runLiveMonitor, verifyLiveCatalogue } from "./monitor-rebate-live.mjs";

const source = "<html>\r\n</html>";
const sourceVersion = crypto.createHash("sha256").update("<html>\n</html>").digest("hex");
assert.equal(verifyLiveCatalogue(source, { sourceVersion, products: [{}] }), sourceVersion);
assert.throws(() => verifyLiveCatalogue(source, { sourceVersion: "old", products: [{}] }), /Live release differs/);
assert.throws(() => verifyLiveCatalogue(source, { sourceVersion, products: [] }), /empty/);
const requests = [];
const fixtureFetch = async (url, options) => {
  requests.push(url);
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.equal(new URL(url).origin, LIVE_ORIGIN);
  if (url.endsWith("/api/public-rebate-catalogue")) return Response.json({ sourceVersion, products: [{}] });
  if (url.endsWith("/")) return new Response("<html>Login</html>");
  return Response.json({ models: [{ model: "RZAS71C2V1 / FDYA71AV19" }] });
};
const passed = await runLiveMonitor({ source, fetchImpl: fixtureFetch });
assert.equal(passed.ok, true);
assert.equal(requests.length, 3);
const failed = await runLiveMonitor({ source, fetchImpl: async () => new Response("Unavailable", { status: 503 }) });
assert.equal(failed.ok, false);
assert.equal(failed.results.filter(item => item.status === "failed").length, 3);
const wrongModel = await runLiveMonitor({ source, fetchImpl: async (url, options) => url.includes("gems-model-search") ? Response.json({ models: [{ model: "DIFFERENT" }] }) : fixtureFetch(url, options) });
assert.equal(wrongModel.ok, false);
assert.equal(wrongModel.results[2].status, "failed");
console.log("Read-only live rebate monitor checks passed.");
