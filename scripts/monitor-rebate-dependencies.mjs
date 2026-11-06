import tls from "node:tls";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { probeRebateService, NSW_CALCULATION_URL } from "../lib/rebate-service-status.ts";
import { probeBackupCalculation } from "./nsw-backup-probe.mjs";

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

export function dependencyHealth(service, certificate, backup) {
  const primaryHealthy = service.available && certificate.ok;
  return {ok:service.available || backup.verified, degraded:!primaryHealthy || !backup.verified, service, certificate, backup};
}

export async function runDependencyMonitor() {
  const service = await probeRebateService();
  const certificate = await checkCertificate(new URL(NSW_CALCULATION_URL).hostname);
  const backup = await probeBackupCalculation();
  return dependencyHealth(service, certificate, backup);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDependencyMonitor();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error("::error::Neither the primary NSW service nor the verified backup is healthy. No rebate eligibility conclusion can be drawn from this failure.");
    process.exitCode = 1;
  } else if (result.degraded) {
    console.warn("::warning::Calculator remains available, but one calculation service needs attention. See the primary TLS and backup accuracy results above.");
  }
}
