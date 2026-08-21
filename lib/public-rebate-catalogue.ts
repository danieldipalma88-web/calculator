import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";

export type PublicRebateSystemType = "split" | "ducted";

export type PublicRebateProduct = {
  id: string;
  systemType: PublicRebateSystemType;
  brand: string;
  series: string;
  capacityKw: number;
  model: string;
  modelAliases: string[];
  searchTerms: string[];
  dcceewEligible?: boolean;
  phase?: "Single" | "Three";
};

type RawProduct = {
  brand?: unknown;
  series?: unknown;
  capacityNum?: unknown;
  size?: unknown;
  model?: unknown;
  phase?: unknown;
  deprecated?: unknown;
  accessory?: unknown;
};

type RawCatalogue = {
  SPLIT_PRODUCTS: RawProduct[];
  DUCTED_PRODUCTS: RawProduct[];
  ANDOS_SPLIT_PRODUCTS: RawProduct[];
  ANDOS_DUCTED_PRODUCTS: RawProduct[];
};

type AliasMap = Record<string, string>;
type LookupAliasMap = Record<string, string[]>;

export type PublicRebateCatalogue = {
  schemaVersion: 1;
  sourceVersion: string;
  products: PublicRebateProduct[];
  fallbackMetadata: Record<string, unknown>[];
  dcceewRate: number;
  dcceewPostcodes: number[];
  counts: {
    split: number;
    ducted: number;
    total: number;
  };
};

function extractExpression<T>(source: string, name: string): T {
  const declaration = new RegExp(`const\\s+${name}\\s*=`).exec(source);
  if (!declaration) throw new Error(`Could not find ${name} in the calculator source.`);

  let start = declaration.index + declaration[0].length;
  while (/\s/.test(source[start] || "")) start += 1;
  const open = source[start];
  const close = open === "[" ? "]" : open === "{" ? "}" : "";
  if (!close) throw new Error(`${name} is not an array or object literal.`);

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close && --depth === 0) {
      return vm.runInNewContext(`(${source.slice(start, index + 1)})`, Object.create(null), { timeout: 2_000 }) as T;
    }
  }
  throw new Error(`Could not read the complete ${name} expression.`);
}

function extractCatalogue(source: string): RawCatalogue {
  const standardStart = source.indexOf("const SPLIT_PRODUCTS");
  const standardEnd = source.indexOf("function andosUnitPriceInc", standardStart);
  const partnerStart = standardEnd;
  const partnerEnd = source.indexOf("const PRODUCT_SUPPORT_DEFAULT", partnerStart);
  if (standardStart < 0 || standardEnd < 0 || partnerEnd < 0) {
    throw new Error("Could not isolate the calculator product catalogues.");
  }

  const sandbox = Object.create(null) as Record<string, unknown>;
  const script = `${source.slice(standardStart, standardEnd)}\n${source.slice(partnerStart, partnerEnd)}\n` +
    "globalThis.__publicRebateCatalogue = { SPLIT_PRODUCTS, DUCTED_PRODUCTS, ANDOS_SPLIT_PRODUCTS, ANDOS_DUCTED_PRODUCTS };";
  vm.runInNewContext(script, sandbox, { timeout: 8_000 });
  return sandbox.__publicRebateCatalogue as RawCatalogue;
}

function normalize(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function normalizeDcceewBrand(value: unknown) {
  const compact = normalize(value);
  if (compact === "ACTRON" || compact === "ACTRONAIR") return "ACTRONAIR";
  if (compact === "FUJITSU" || compact === "FUJITSUGENERAL") return "FUJITSU";
  return compact;
}

function dcceewProductKey(brand: unknown, model: unknown) {
  return `${normalizeDcceewBrand(brand)}|${normalize(model)}`;
}

function unique(values: unknown[]) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function modelSearchTerms(models: string[]) {
  const terms: string[] = [];
  for (const model of models) {
    terms.push(model);
    const parts = String(model).split("/").map((part) => part.trim()).filter((part) => normalize(part).length >= 5);
    terms.push(...parts);
    if (parts.length === 2) terms.push(`${parts[1]} / ${parts[0]}`);
  }
  return unique(terms).slice(0, 10);
}

function slug(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}

function productId(product: Omit<PublicRebateProduct, "id">) {
  const identity = [product.systemType, product.brand, product.model, product.phase || ""].join("|");
  const hash = createHash("sha1").update(identity).digest("hex").slice(0, 10);
  return `${slug(`${product.systemType}-${product.brand}-${product.series}-${product.capacityKw}`)}-${hash}`;
}

function productIdentity(product: PublicRebateProduct) {
  return [product.systemType, normalize(product.brand), normalize(product.model), product.phase || ""].join("|");
}

function parseDcceewData(source: string) {
  const postcodes = extractExpression<number[]>(source, "DCCEEW_ELIGIBLE_POSTCODES");
  const rate = Number(/DCCEEW_CONTRACT_RATE\s*=\s*([\d.]+)/.exec(source)?.[1]);
  if (!Array.isArray(postcodes) || !postcodes.length || !(rate > 0)) {
    throw new Error("Could not read the DCCEEW contract settings.");
  }
  return { postcodes, rate };
}

export async function buildPublicRebateCatalogue(): Promise<PublicRebateCatalogue> {
  const root = process.cwd();
  const [source, dcceewRegisterSource, dcceewDataSource] = await Promise.all([
    readFile(join(root, "index.html"), "utf8"),
    readFile(join(root, "lib", "dcceew-contract-products.json"), "utf8"),
    readFile(join(root, "lib", "dcceew-contract-data.ts"), "utf8"),
  ]);
  const rawCatalogue = extractCatalogue(source);
  const brandAliases = extractExpression<AliasMap>(source, "BRAND_ALIASES");
  const modelAliases = extractExpression<AliasMap>(source, "MODEL_ALIASES");
  const displayAliases = extractExpression<AliasMap>(source, "PRODUCT_MODEL_DISPLAY_ALIASES");
  const lookupAliases = extractExpression<LookupAliasMap>(source, "REBATE_LOOKUP_MODEL_ALIASES");
  const fallbackMetadata = extractExpression<Record<string, unknown>[]>(source, "LOCAL_GEMS_MODEL_METADATA_ROWS");
  const dcceewRegister = JSON.parse(dcceewRegisterSource) as unknown;
  if (!Array.isArray(dcceewRegister) || !dcceewRegister.length) {
    throw new Error("Could not read the DCCEEW product register.");
  }
  const dcceewKeys = new Set(dcceewRegister.map(String));
  const dcceew = parseDcceewData(dcceewDataSource);

  const mapProduct = (rawProduct: RawProduct, systemType: PublicRebateSystemType): PublicRebateProduct => {
    const rawBrand = String(rawProduct.brand || "").trim();
    const rawModel = String(rawProduct.model || "").trim();
    const brand = brandAliases[rawBrand] || rawBrand;
    const model = displayAliases[rawModel] || modelAliases[rawModel] || rawModel;
    const aliases = unique([
      model,
      rawModel,
      ...(lookupAliases[normalize(model)] || lookupAliases[normalize(rawModel)] || []),
    ]);
    const capacityKw = Number(rawProduct.capacityNum ?? rawProduct.size);
    const product: Omit<PublicRebateProduct, "id"> = {
      systemType,
      brand,
      series: String(rawProduct.series || (systemType === "ducted" ? "Ducted" : "Split system")),
      capacityKw,
      model,
      modelAliases: aliases,
      searchTerms: modelSearchTerms(aliases),
      ...(dcceewKeys.has(dcceewProductKey(brand, model)) ? { dcceewEligible: true } : {}),
      ...(rawProduct.phase === "Single" || rawProduct.phase === "Three" ? { phase: rawProduct.phase } : {}),
    };
    return { id: productId(product), ...product };
  };

  const sourceProducts: Array<[RawProduct[], PublicRebateSystemType]> = [
    [rawCatalogue.SPLIT_PRODUCTS, "split"],
    [rawCatalogue.DUCTED_PRODUCTS, "ducted"],
    [rawCatalogue.ANDOS_SPLIT_PRODUCTS, "split"],
    [rawCatalogue.ANDOS_DUCTED_PRODUCTS, "ducted"],
  ];
  const productsByIdentity = new Map<string, PublicRebateProduct>();
  for (const [rawProducts, systemType] of sourceProducts) {
    for (const rawProduct of rawProducts) {
      if (rawProduct.deprecated || rawProduct.accessory) continue;
      const product = mapProduct(rawProduct, systemType);
      if (!product.brand || !product.model || !product.series || !(product.capacityKw > 0)) continue;
      const identity = productIdentity(product);
      if (!productsByIdentity.has(identity)) productsByIdentity.set(identity, product);
    }
  }
  const products = [...productsByIdentity.values()];
  const split = products.filter((product) => product.systemType === "split").length;
  const ducted = products.filter((product) => product.systemType === "ducted").length;
  if (!products.length || !split || !ducted) throw new Error("The public rebate catalogue is empty or incomplete.");

  return {
    schemaVersion: 1,
    sourceVersion: createHash("sha256").update(source).digest("hex"),
    products,
    fallbackMetadata,
    dcceewRate: dcceew.rate,
    dcceewPostcodes: dcceew.postcodes,
    counts: { split, ducted, total: products.length },
  };
}
