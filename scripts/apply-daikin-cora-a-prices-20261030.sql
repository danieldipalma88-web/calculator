-- Approved shared prices, including GST. Do not modify saved quotes or other models.
BEGIN;
DO $$
DECLARE
  business_row record;
  entry_key text;
  entry_value jsonb;
  prices jsonb;
  updated_prices jsonb;
  normalized_model text;
  target_price numeric;
  current_price numeric;
BEGIN
  FOR business_row IN
    SELECT business_id, data
    FROM public.business_calculator_data
    WHERE data::text LIKE '%RXV25AVMA%' OR data::text LIKE '%RXV50AVMA%'
    ORDER BY business_id
    FOR UPDATE
  LOOP
    prices := CASE jsonb_typeof(business_row.data->'installerManagedPricesV1')
      WHEN 'string' THEN (business_row.data->>'installerManagedPricesV1')::jsonb
      WHEN 'object' THEN business_row.data->'installerManagedPricesV1'
      ELSE '{}'::jsonb END;
    updated_prices := prices;
    FOR entry_key, entry_value IN SELECT key, value FROM jsonb_each(prices)
    LOOP
      normalized_model := regexp_replace(upper(entry_value->>'model'), '[^A-Z0-9]', '', 'g');
      target_price := CASE normalized_model
        WHEN 'RXV25AVMAFTXV25AVMA' THEN 850
        WHEN 'RXV50AVMAFTXV50AVMA' THEN 1420
        ELSE NULL END;
      IF target_price IS NULL THEN CONTINUE; END IF;
      current_price := (entry_value->>'unitPriceInc')::numeric;
      IF current_price IS NULL OR current_price NOT IN (0, target_price) THEN
        RAISE EXCEPTION 'Cora price changed since audit for business %, model %; re-review before overwriting', business_row.business_id, normalized_model;
      END IF;
      IF current_price = 0 THEN
        updated_prices := jsonb_set(updated_prices, ARRAY[entry_key, 'unitPriceInc'], to_jsonb(target_price), false);
      END IF;
    END LOOP;
    IF updated_prices IS DISTINCT FROM prices THEN
      UPDATE public.business_calculator_data
      SET data = jsonb_set(business_row.data, ARRAY['installerManagedPricesV1'],
        CASE jsonb_typeof(business_row.data->'installerManagedPricesV1')
          WHEN 'string' THEN to_jsonb(updated_prices::text)
          ELSE updated_prices END, false),
        updated_at = clock_timestamp()
      WHERE business_id = business_row.business_id;
    END IF;
  END LOOP;
END $$;
COMMIT;

WITH price_maps AS (
  SELECT business_id, CASE jsonb_typeof(data->'installerManagedPricesV1')
    WHEN 'string' THEN (data->>'installerManagedPricesV1')::jsonb
    WHEN 'object' THEN data->'installerManagedPricesV1' ELSE '{}'::jsonb END AS prices
  FROM public.business_calculator_data
)
SELECT value->>'model' AS model, value->>'unitPriceInc' AS unit_price_inc_gst,
  count(*) AS price_entries, count(DISTINCT business_id) AS businesses
FROM price_maps CROSS JOIN LATERAL jsonb_each(prices)
WHERE regexp_replace(upper(value->>'model'), '[^A-Z0-9]', '', 'g')
  IN ('RXV25AVMAFTXV25AVMA', 'RXV50AVMAFTXV50AVMA')
GROUP BY value->>'model', value->>'unitPriceInc'
ORDER BY model, unit_price_inc_gst;
