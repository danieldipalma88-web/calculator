import { readFileSync } from "node:fs";

function assertIncludes(file, content, expected, label) {
  if (!content.includes(expected)) {
    throw new Error(`${file} is missing ${label}: ${expected}`);
  }
}

const indexHtml = readFileSync("index.html", "utf8");
const rawRoute = readFileSync("app/calculator/raw/route.ts", "utf8");
const adminPage = readFileSync("app/admin/users/page.tsx", "utf8");
const globals = readFileSync("app/globals.css", "utf8");

assertIncludes(
  "app/calculator/raw/route.ts",
  rawRoute,
  "window.CALCULATOR_GOOGLE_MAPS_BROWSER_KEY",
  "calculator Google Maps browser-key injection",
);

[
  "wonJobsInstallDate",
  "wonJobsMap",
  "function renderWonJobsInstallMap",
  "installationLatitude",
  "installationLongitude",
].forEach((expected) => assertIncludes("index.html", indexHtml, expected, `user Won Jobs map hook ${expected}`));

[
  "installationLatitude: number | null",
  "installationLongitude: number | null",
  "data-won-install-map-date",
  "data-won-install-map",
  "data-install-lat",
  "data-install-lng",
  "function updateWonInstallMap",
  "window.ADMIN_GOOGLE_MAPS_BROWSER_KEY",
].forEach((expected) => assertIncludes("app/admin/users/page.tsx", adminPage, expected, `admin Won Quotes map hook ${expected}`));

[
  ".wonJobsMapCanvas",
  ".won-install-map-canvas",
  ".won-install-map-panel",
].forEach((expected) => {
  const file = expected.startsWith(".wonJobs") ? "index.html" : "app/globals.css";
  const content = expected.startsWith(".wonJobs") ? indexHtml : globals;
  assertIncludes(file, content, expected, `map style ${expected}`);
});

console.log("Install map feature wiring verified.");
