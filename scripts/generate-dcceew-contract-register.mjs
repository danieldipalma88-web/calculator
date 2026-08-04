import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [analysisPath, outputPath] = process.argv.slice(2);
if (!analysisPath || !outputPath) {
  throw new Error("Usage: generate-dcceew-contract-register.mjs missing-products.json output.json");
}

const analysis = JSON.parse(fs.readFileSync(path.resolve(analysisPath), "utf8"));
const existingSourcePath = path.resolve("lib/dcceew-contract-data.ts");
const existingSource = fs.existsSync(existingSourcePath)
  ? fs.readFileSync(existingSourcePath, "utf8")
  : "";
const existingRegisterPath = path.resolve("lib/dcceew-contract-products.json");
const existingRegister = fs.existsSync(existingRegisterPath)
  ? JSON.parse(fs.readFileSync(existingRegisterPath, "utf8"))
  : [];
const existingKeys = [
  ...existingRegister,
  ...[...existingSource.matchAll(/"([A-Z0-9]+\|[^"\r\n]+)"/g)].map(([, key]) => key),
];

function isLiteralModel(value) {
  const model = String(value || "");
  return model && !/\*|\bSeries\b/i.test(model);
}

const keys = new Set(existingKeys);
for (const row of Array.isArray(analysis.sourceProducts)
  ? analysis.sourceProducts
  : analysis.missing || []) {
  if (isLiteralModel(row.model) && row.key) keys.add(String(row.key));
}

const sorted = [...keys].sort((a, b) => a.localeCompare(b));
fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(sorted, null, 2)}\n`);
console.log(JSON.stringify({ output: path.resolve(outputPath), count: sorted.length }, null, 2));
