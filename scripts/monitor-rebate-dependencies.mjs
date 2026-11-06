import tls from "node:tls";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { probeRebateService, NSW_CALCULATION_URL } from "../lib/rebate-service-status.ts";
import { probeBackupCalculation, probePrimaryCalculation } from "./nsw-backup-probe.mjs";

export function checkCertificate(host, connect = tls.connect, now = Date.now()) {
  return new Promise(resolve => {
    let finished = false;
    const socket = connect({ host, port:443, servername:host, rejectUnauthorized:true });
    const timeout = setTimeout(() => finish({ok:false, reason:"TLS check timed out"}), 5000);
    function finish(value) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve({host, ...value});
    }
    socket.once("error", error => finish({ok:false, reason:error.code || "TLS connection failed"}));
    socket.once("secureConnect", () => {
      const expiry = socket.getPeerCertificate().valid_to;
      const daysRemaining = (Date.parse(expiry) - now) / 86_400_000;
      finish({ok:Number.isFinite(daysRemaining) && daysRemaining > 7, expiresAt:expiry,
        daysRemaining:Number.isFinite(daysRemaining) ? Math.floor(daysRemaining) : null,
        reason:daysRemaining > 7 ? "valid" : "Certificate expires within seven days"});
    });
  });
}

export async function probeCatalogueLookup(fetchImpl = fetch) {
  try {
    const response = await fetchImpl("https://calculator.rebateportal.com.au/api/gems-model-search?brand=Daikin&q=RZAS71C2V1", {
      signal: AbortSignal.timeout(20_000), redirect: "error", headers: { Accept: "application/json" }, cache: "no-store",
    });
    if (!response.ok || response.redirected) throw new Error(`Model search HTTP ${response.status}`);
    const payload = await response.json();
    const found = payload.models?.some(item => item.brand?.toUpperCase() === "DAIKIN"
      && item.model?.replace(/[^A-Z0-9]/gi, "").toUpperCase() === "RZAS71C2V1FDYA71AV19" && item.completeEnergyData === true);
    if (!found) throw new Error("Known registered model or complete ratings missing from live search");
    return { verified: true };
  } catch (error) {
    return { verified: false, reason: error instanceof Error ? error.message : "Live model search unavailable" };
  }
}

export function dependencyHealth(service, certificate, backup, primary = { verified: service.available }, registry = { verified: true }) {
  const primaryAvailable = service.available && primary.verified;
  const primaryHealthy = primaryAvailable && certificate.ok;
  return {ok:(primaryAvailable || backup.verified) && registry.verified, degraded:!primaryHealthy || !backup.verified || !registry.verified, service, certificate, backup, primary, registry};
}

export async function runDependencyMonitor() {
  const service = await probeRebateService();
  const certificate = await checkCertificate(new URL(NSW_CALCULATION_URL).hostname);
  const primary = await probePrimaryCalculation();
  const backup = await probeBackupCalculation();
  const registry = await probeCatalogueLookup();
  return { checkedAt: new Date().toISOString(), ...dependencyHealth(service, certificate, backup, primary, registry) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDependencyMonitor();
  const output = process.argv.slice(2).find(arg => arg.startsWith("--output="))?.slice(9);
  if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error("::error::Calculation availability or live model search failed verification. No rebate eligibility conclusion can be drawn from this failure.");
    process.exitCode = 1;
  } else if (result.degraded) {
    console.warn("::warning::Calculator remains available, but one calculation service needs attention. See the primary TLS and backup accuracy results above.");
  }
}
