import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkCertificate } from "./monitor-rebate-dependencies.mjs";

async function scenario(days, error) {
  let destroyed = false;
  const now = Date.parse("2026-11-06T00:00:00Z");
  const result = await checkCertificate("example.test", options => {
    assert.equal(options.rejectUnauthorized, true, "Certificate validation must never be bypassed");
    assert.equal(options.servername, "example.test");
    const socket = new EventEmitter();
    socket.destroy = () => { destroyed = true; };
    socket.getPeerCertificate = () => ({ valid_to:new Date(now + days * 86_400_000).toUTCString() });
    queueMicrotask(() => error ? socket.emit("error", {code:error}) : socket.emit("secureConnect"));
    return socket;
  }, now);
  assert.equal(destroyed, true);
  return result;
}
assert.equal((await scenario(30)).ok, true);
assert.equal((await scenario(7)).ok, false);
assert.equal((await scenario(1)).ok, false);
assert.equal((await scenario(0, "CERT_HAS_EXPIRED")).reason, "CERT_HAS_EXPIRED");
console.log("TLS expiry monitor validates certificates and warns seven days before expiry.");
