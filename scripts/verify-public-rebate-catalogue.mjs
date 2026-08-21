import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const catalogue = await buildPublicRebateCatalogue();
const identities = new Set(catalogue.products.map((product) => `${product.systemType}|${product.brand}|${product.model}|${product.phase || ""}`));
if (identities.size !== catalogue.products.length) throw new Error("The public rebate catalogue contains duplicate products.");
if (catalogue.counts.total !== catalogue.products.length) throw new Error("The public rebate catalogue count is incorrect.");

for (const expected of [
  ["split", "Braemar", "ACHV25D1S / ASHV25D1S"],
  ["ducted", "Braemar", "KCHA070D1B / KDHA070D1S"],
  ["split", "Gree", "GWH09ATBXB-K6DNA1C/O / GWH09ATBXB-K6DNA1C/I"],
  ["ducted", "Gree", "GUD50W1/NhC-S / GUD50PHS1/C-S"],
]) {
  const [systemType, brand, model] = expected;
  if (!catalogue.products.some((product) => product.systemType === systemType && product.brand === brand && product.model === model)) {
    throw new Error(`Missing expected ${brand} product ${model}.`);
  }
}

console.log(`Public rebate catalogue verified: ${catalogue.counts.split} split systems, ${catalogue.counts.ducted} ducted systems, ${catalogue.counts.total} total.`);
