import fs from "node:fs";
import vm from "node:vm";

const calculator = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const adminPage = fs.readFileSync(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8");

function functionSource(name) {
  const start = calculator.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < calculator.length; index += 1) {
    if (calculator[index] === "{") {
      depth += 1;
      opened = true;
    } else if (calculator[index] === "}") {
      depth -= 1;
      if (opened && depth === 0) return calculator.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

const context = {};
vm.runInNewContext(
  [
    functionSource("isMultiHeadQuoteType"),
    functionSource("finiteMoneyNumber"),
    functionSource("savedPowerOrElectricianEx"),
    "result = savedPowerOrElectricianEx;",
  ].join("\n"),
  context,
);

const savedPowerOrElectricianEx = context.result;
const checks = [
  [savedPowerOrElectricianEx({ type: "Ducted", powerCost: 500 }) === 500, "new ducted amount"],
  [savedPowerOrElectricianEx({ type: "Ducted", powerCost: 0 }) === 0, "new ducted zero"],
  [savedPowerOrElectricianEx({ type: "Ducted", state: { electrician: "750.00" } }) === 750, "legacy ducted electrician fallback"],
  [savedPowerOrElectricianEx({ type: "Ducted", state: {} }) === 0, "missing ducted amount displays zero"],
  [savedPowerOrElectricianEx({ type: "Split", powerCost: 400 }) === 400, "split power amount"],
  [calculator.includes("powerCost:x.service"), "all new standard rows save service cost"],
  [calculator.includes("const power=money(savedPowerOrElectricianEx(r));"), "quote tables render a currency amount"],
  [!calculator.match(/const power=quoteUsesPowerCost\(r\)[^\n]+['\"]N\/A['\"]/), "quote tables no longer use N/A"],
  [calculator.includes("const service=savedPowerOrElectricianEx(r);"), "saved quote recomputation uses recovered amount"],
  [adminPage.includes("powerEx: quotePowerOrElectricianEx(quote)"), "admin exports recover electrician amount"],
];

const failed = checks.filter(([passed]) => !passed);
if (failed.length) {
  failed.forEach(([, label]) => console.error(`FAILED: ${label}`));
  process.exit(1);
}

console.log("power / electrician display checks passed");
