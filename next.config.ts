import type { NextConfig } from "next";

const researchFiles = ["./lib/model-research/manufacturer-pdf-worker.mjs", "./lib/model-research/manufacturer-table.mjs",
  "./node_modules/pdfjs-dist/**/*", "./node_modules/@napi-rs/canvas*/**/*"];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pdfjs-dist"],
  outputFileTracingIncludes: Object.fromEntries([
    "/api/model-requests", "/api/model-requests/respond", "/api/admin/model-requests",
    "/api/cron/model-requests", "/api/internal/model-research",
  ].map(route => [route, researchFiles])),
};

export default nextConfig;
