import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GST_RATE = 0.1;
const MAX_PRICE = 1_000_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function currencyFromExGst(value, gstRate = DEFAULT_GST_RATE) {
  const cents = Math.round(Number(value) * 100);
  return Math.round(cents * (1 + gstRate)) / 100;
}

function canonicalModel(model) {
  return String(model || "")
    .split("/")
    .map((part) => part.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean)
    .sort()
    .join("/");
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function preparePriceUpdate(input) {
  assert(input && typeof input === "object" && !Array.isArray(input), "Input must be a JSON object.");

  const businessName = String(input.businessName || "").trim();
  const priceBasis = String(input.priceBasis || "").trim().toLowerCase();
  const gstRate = input.gstRate === undefined ? DEFAULT_GST_RATE : Number(input.gstRate);
  const prices = input.prices;

  assert(businessName, "businessName is required.");
  assert(businessName.length <= 200 && !/[\r\n]/.test(businessName), "businessName must be a single line of 200 characters or fewer.");
  assert(priceBasis === "ex_gst" || priceBasis === "inc_gst", "priceBasis must be ex_gst or inc_gst.");
  assert(Number.isFinite(gstRate) && gstRate >= 0 && gstRate <= 1, "gstRate must be between 0 and 1.");
  assert(Array.isArray(prices) && prices.length > 0, "prices must contain at least one model.");
  assert(prices.length <= 200, "A single update is limited to 200 models.");

  const seenModels = new Set();
  const preparedPrices = prices.map((entry, index) => {
    assert(entry && typeof entry === "object" && !Array.isArray(entry), `prices[${index}] must be an object.`);

    const suppliedModel = String(entry.model || "").trim();
    const modelKey = canonicalModel(suppliedModel);
    const sourcePrice = Number(entry.price);

    assert(suppliedModel, `prices[${index}].model is required.`);
    assert(suppliedModel.length <= 200 && !/[\r\n]/.test(suppliedModel), `prices[${index}].model must be a single line of 200 characters or fewer.`);
    assert(modelKey, `prices[${index}].model does not contain a usable model number.`);
    assert(!seenModels.has(modelKey), `Duplicate model in request: ${suppliedModel}.`);
    assert(Number.isFinite(sourcePrice) && sourcePrice >= 0 && sourcePrice <= MAX_PRICE, `Invalid price for ${suppliedModel}.`);

    seenModels.add(modelKey);
    const priceIncGst = priceBasis === "ex_gst"
      ? currencyFromExGst(sourcePrice, gstRate)
      : roundCurrency(sourcePrice);

    return {
      model_key: modelKey,
      supplied_model: suppliedModel,
      source_price: roundCurrency(sourcePrice),
      price_basis: priceBasis,
      price_inc_gst: priceIncGst,
    };
  });

  return { businessName, priceBasis, gstRate, prices: preparedPrices };
}

function generateSql(input) {
  const prepared = preparePriceUpdate(input);
  const requestJson = JSON.stringify(prepared.prices);
  const requestLiteral = sqlLiteral(requestJson);
  const businessLiteral = sqlLiteral(prepared.businessName);
  const conversionLabel = prepared.priceBasis === "ex_gst"
    ? `Converted from ex GST at ${(prepared.gstRate * 100).toFixed(2)}% GST.`
    : "Supplied prices are already inc GST.";

  return `-- Business-specific managed price update
-- Target: ${prepared.businessName.replaceAll("\n", " ")}
-- ${conversionLabel}
-- Generated values: ${prepared.prices.map((item) => `${item.supplied_model} = $${item.price_inc_gst.toFixed(2)} inc GST`).join("; ")}
-- Safety: the transaction aborts unless the business and every model match exactly once.

begin;

do $business_price_update$
declare
  v_business_id uuid;
  v_business_count integer;
  v_data jsonb;
  v_managed jsonb;
  v_request constant jsonb := '${requestLiteral}'::jsonb;
  v_item jsonb;
  v_key text;
  v_entry jsonb;
  v_entry_model_key text;
  v_match_key text;
  v_matches integer;
begin
  select count(*)
    into v_business_count
  from public.businesses
  where lower(btrim(name)) = lower(btrim('${businessLiteral}'));

  if v_business_count <> 1 then
    raise exception 'Expected exactly one business named %, found %', '${businessLiteral}', v_business_count;
  end if;

  select id
    into v_business_id
  from public.businesses
  where lower(btrim(name)) = lower(btrim('${businessLiteral}'));

  select data
    into v_data
  from public.business_calculator_data
  where business_id = v_business_id
  for update;

  if not found then
    raise exception 'No business_calculator_data row exists for %', '${businessLiteral}';
  end if;

  begin
    v_managed := coalesce((v_data ->> 'installerManagedPricesV1')::jsonb, '{}'::jsonb);
  exception when others then
    raise exception 'installerManagedPricesV1 is not valid JSON for %', '${businessLiteral}';
  end;

  if jsonb_typeof(v_managed) <> 'object' then
    raise exception 'installerManagedPricesV1 must contain a JSON object for %', '${businessLiteral}';
  end if;

  for v_item in select value from jsonb_array_elements(v_request)
  loop
    v_matches := 0;
    v_match_key := null;

    for v_key, v_entry in select key, value from jsonb_each(v_managed)
    loop
      select string_agg(token, '/' order by token)
        into v_entry_model_key
      from (
        select regexp_replace(upper(btrim(part)), '[^A-Z0-9]', '', 'g') as token
        from unnest(string_to_array(coalesce(v_entry ->> 'model', ''), '/')) as part
        where btrim(part) <> ''
      ) normalized;

      if v_entry_model_key = v_item ->> 'model_key' then
        v_matches := v_matches + 1;
        v_match_key := v_key;
      end if;
    end loop;

    if v_matches <> 1 then
      raise exception 'Expected exactly one managed model match for %, found %', v_item ->> 'supplied_model', v_matches;
    end if;

    v_managed := jsonb_set(
      v_managed,
      array[v_match_key, 'unitPriceInc'],
      to_jsonb((v_item ->> 'price_inc_gst')::numeric),
      true
    );
    v_managed := jsonb_set(v_managed, array[v_match_key, 'locked'], 'true'::jsonb, true);
  end loop;

  update public.business_calculator_data
  set data = jsonb_set(
        coalesce(data, '{}'::jsonb),
        '{installerManagedPricesV1}',
        to_jsonb(v_managed::text),
        true
      ),
      updated_at = now()
  where business_id = v_business_id;

  if not found then
    raise exception 'Business price update did not modify the target row for %', '${businessLiteral}';
  end if;
end
$business_price_update$;

-- Read-back verification. Every requested model must be returned once with the new price and locked=true.
with requested as (
  select *
  from jsonb_to_recordset('${requestLiteral}'::jsonb) as item(
    model_key text,
    supplied_model text,
    source_price numeric,
    price_basis text,
    price_inc_gst numeric
  )
), target_business as (
  select id, name
  from public.businesses
  where lower(btrim(name)) = lower(btrim('${businessLiteral}'))
), managed as (
  select target_business.name,
         (business_calculator_data.data ->> 'installerManagedPricesV1')::jsonb as prices
  from target_business
  join public.business_calculator_data
    on business_calculator_data.business_id = target_business.id
), stored as (
  select managed.name,
         entry.key as managed_key,
         entry.value as managed_entry,
         (
           select string_agg(token, '/' order by token)
           from (
             select regexp_replace(upper(btrim(part)), '[^A-Z0-9]', '', 'g') as token
             from unnest(string_to_array(coalesce(entry.value ->> 'model', ''), '/')) as part
             where btrim(part) <> ''
           ) normalized
         ) as model_key
  from managed
  cross join lateral jsonb_each(managed.prices) as entry
)
select stored.name as business,
       requested.supplied_model as requested_model,
       stored.managed_entry ->> 'model' as stored_model,
       requested.source_price,
       requested.price_basis,
       requested.price_inc_gst as expected_inc_gst,
       (stored.managed_entry ->> 'unitPriceInc')::numeric as stored_inc_gst,
       coalesce((stored.managed_entry ->> 'locked')::boolean, false) as locked,
       stored.managed_key
from requested
join stored using (model_key)
order by requested.supplied_model;

commit;
`;
}

function runCli() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath) {
    console.error("Usage: node scripts/generate-business-price-update-sql.mjs <request.json> [output.sql]");
    process.exitCode = 1;
    return;
  }

  const absoluteInputPath = path.resolve(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(absoluteInputPath, "utf8"));
  const sql = generateSql(input);

  if (outputPath) {
    const absoluteOutputPath = path.resolve(process.cwd(), outputPath);
    fs.writeFileSync(absoluteOutputPath, sql, "utf8");
    console.log(`Generated ${absoluteOutputPath}`);
    return;
  }

  process.stdout.write(sql);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) runCli();

export { canonicalModel, currencyFromExGst, generateSql, preparePriceUpdate, roundCurrency };
