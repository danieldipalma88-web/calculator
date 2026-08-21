import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const catalogue = await buildPublicRebateCatalogue();
const outputPath = resolve(import.meta.dirname, "..", "lib", "public-rebate-catalogue.generated.json");

await writeFile(outputPath, `${JSON.stringify(catalogue)}\n`, "utf8");

console.log(
  `Generated public rebate catalogue: ${catalogue.counts.split} split systems, `
    + `${catalogue.counts.ducted} ducted systems, ${catalogue.counts.total} total.`,
);
