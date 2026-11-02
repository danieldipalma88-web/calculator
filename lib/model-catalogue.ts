import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import catalogue from "./public-rebate-catalogue.generated.json";
import { supabaseUrl, supabasePublishableKey } from "./supabase/config";
import type { PublicRebateProduct } from "./public-rebate-catalogue";

export type AddedModel = {
  id: string;
  product: { systemType: "split" | "ducted"; brand: string; model: string; series: string; capacityKw: number; phase: "Single" | "Three" };
  active: boolean;
  created_at: string;
};

export function modelIdentity(brand: string, model: string) {
  const normalize = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");
  return `${normalize(brand)}|${model.split("/").map(normalize).sort().join("/")}`;
}

export function catalogueClient() {
  if (!supabaseUrl || !supabasePublishableKey) throw new Error("Catalogue database is not configured");
  return createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8_000) }) },
  });
}

export async function readAddedModels(): Promise<AddedModel[]> {
  const result = await catalogueClient().from("calculator_catalogue_additions")
    .select("id, product, active, created_at").eq("active", true).order("created_at").order("id");
  if (result.error) throw new Error("Verified catalogue additions are unavailable");
  return (result.data || []) as AddedModel[];
}

export function calculatorAddedProducts(rows: AddedModel[]) {
  return rows.filter(r => r.active).map(({ id, product: p }) => ({
    ...p, catalogueAdditionId: id, type: p.systemType, size: p.capacityKw, capacityNum: p.capacityKw,
    capacity: `${p.capacityKw}kW`, unitPriceInc: 0, priceIncGst: 0, rebate: 0, nswOnly: true,
    wifiStatus: "unknown", wifiLabel: "Wi-Fi unconfirmed", warrantyYears: 0, warrantyLabel: "Warranty unconfirmed", originLabel: "Not confirmed",
  }));
}

export function mergedPublicCatalogue(rows: AddedModel[]) {
  const products: PublicRebateProduct[] = [...catalogue.products] as PublicRebateProduct[];
  const seen = new Set(products.map(p => modelIdentity(p.brand, p.model)));
  for (const row of rows) {
    const p = row.product;
    const key = modelIdentity(p.brand, p.model);
    if (!row.active || seen.has(key)) continue;
    seen.add(key);
    products.push({ ...p, id: `verified-${row.id}`, modelAliases: [p.model], searchTerms: [p.model, ...p.model.split("/").map(s => s.trim())] });
  }
  return { ...catalogue, products,
    sourceVersion: createHash("sha256").update(catalogue.sourceVersion + JSON.stringify(rows)).digest("hex"),
    counts: { split: products.filter(p => p.systemType === "split").length, ducted: products.filter(p => p.systemType === "ducted").length, total: products.length },
  };
}
