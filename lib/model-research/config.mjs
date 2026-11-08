export const MODEL = 'gpt-6.1-sol';
export const MAX_OUTPUT = 4096;
export const MAX_ROUNDS = 8;
export const MAX_SEARCHES = 2;
export const CONTEXT_WINDOW = 1_050_000;
export const MONTHLY_LIMIT_MICROS = 20_000_000;
// The store must seed this already-spent amount, independently of SQL defaults.
export const INITIAL_SPENT_MICROS = 1_063_705;
export const INITIAL_SPENT_MONTH = '2026-11';
export const PROVIDER_TIMEOUT_MS = 90_000;
export const REGISTRY_TIMEOUT_MS = 20_000;
export const INVOCATION_TIMEOUT_MS = 270_000;
export const DEADLINE_MARGIN_MS = 15_000;
export const PRICING = Object.freeze({
  checked: '2026-11-09',
  reviewBy: '2026-12-09',
  // Includes long-context input/cache-write and output uplifts at Standard speed.
  inputPerMillion: 5,
  outputPerMillion: 15,
  search: 0.01,
  source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
});

export function assertPricingCurrent(now = new Date()) {
  if (now.toISOString().slice(0, 10) > PRICING.reviewBy) throw new Error('Model/search pricing needs review before further paid calls');
}

function amount(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error('Invalid research budget configuration');
  return n;
}

export function configuration(env = process.env) {
  const fx = amount(env.MODEL_RESEARCH_AUD_PER_USD, 2.2, 10);
  if (fx < 2.2) throw new Error('The approved FX/tax allowance cannot be reduced below 2.2 without review');
  return {
    apiKey: env.OPENAI_API_KEY || '',
    enabled: env.MODEL_RESEARCH_ENABLED === 'true',
    // Raising the approved ceiling requires a code/config review, not an AI tool call.
    limitMicros: Math.floor(amount(env.MODEL_RESEARCH_MONTHLY_AUD, 20, 20) * 1e6),
    fx,
  };
}

export function sydneyMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit',
  }).formatToParts(now);
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

export function costMicros(usage, searches, fx) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0
    || usage.input_tokens > CONTEXT_WINDOW
    || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0
    || usage.output_tokens > MAX_OUTPUT
    || !Number.isSafeInteger(searches) || searches < 0 || searches > MAX_SEARCHES
    || !Number.isFinite(fx) || fx < 2.2 || fx > 10) throw new Error('Missing auditable API usage or usage exceeded its reserved bound');
  const usdMicros = usage.input_tokens * PRICING.inputPerMillion
    + usage.output_tokens * PRICING.outputPerMillion + searches * Math.ceil(PRICING.search * 1e6);
  // Integer ceiling avoids floating-point under-reservation at micro-dollar boundaries.
  const [whole, fractional = ''] = String(fx).split('.');
  const denominator = 10n ** BigInt(fractional.length);
  const numerator = BigInt(whole + fractional);
  return Number((BigInt(usdMicros) * numerator + denominator - 1n) / denominator);
}

export function reservationMicros(fx) {
  // Reserve the entire model context, not a guess at search-result size.
  return costMicros({ input_tokens: CONTEXT_WINDOW, output_tokens: MAX_OUTPUT }, MAX_SEARCHES, fx);
}
