import { MODEL, MAX_ROUNDS, MONTHLY_LIMIT_MICROS, INITIAL_SPENT_MONTH, INITIAL_SPENT_MICROS,
  PROVIDER_TIMEOUT_MS, REGISTRY_TIMEOUT_MS, INVOCATION_TIMEOUT_MS, DEADLINE_MARGIN_MS,
  assertPricingCurrent, costMicros, reservationMicros, sydneyMonth } from './config.mjs';
import { researchInput, requestDetails, validateFinding } from './registry.mjs';

function collectedSources(output) {
  const urls = [];
  for (const item of output) {
    for (const source of item.action?.sources || []) if (source.url?.startsWith('https://')) urls.push(source.url);
    for (const content of item.content || []) for (const a of content.annotations || []) {
      if (a.type === 'url_citation' && a.url?.startsWith('https://')) urls.push(a.url);
    }
  }
  return urls;
}

function finalText(output) {
  return output.filter(x => x.type === 'message').flatMap(x => x.content || [])
    .filter(x => x.type === 'output_text').map(x => x.text).join('');
}

export class ResearchAgent {
  constructor({ store, provider, registry, config, clock = () => performance.now(), maxDurationMs = INVOCATION_TIMEOUT_MS }) {
    Object.assign(this, { store, provider, registry, config, clock });
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > INVOCATION_TIMEOUT_MS) {
      throw new Error('Invalid research invocation deadline');
    }
    this.maxDurationMs = maxDurationMs;
  }

  async run(id) {
    const deadline = this.clock() + this.maxDurationMs;
    const hasTime = duration => this.clock() + duration + DEADLINE_MARGIN_MS < deadline;
    const claim = await this.store.claim(id);
    if (!claim) return await this.store.get(id);
    const { job, lease } = claim;
    let records = new Map();
    let sources = new Set();
    try {
      const request = requestDetails(job.request);
      const saved = job.checkpoint || { round: 0,
        input: [{ role: 'user', content: JSON.stringify(researchInput(request)) }], records: [], sources: [] };
      if (!Number.isSafeInteger(saved.round) || saved.round < 0 || saved.round > MAX_ROUNDS
        || !Array.isArray(saved.input) || !Array.isArray(saved.records) || !Array.isArray(saved.sources)) {
        throw new Error('Invalid durable investigation checkpoint');
      }
      records = new Map(saved.records.map(record => [JSON.stringify(record), record]));
      sources = new Set(saved.sources);
      const input = saved.input;
      const checkpoint = async (round, response = null) => {
        await this.store.checkpoint(job.id, lease, { round, input, records: [...records.values()], sources: [...sources], response });
      };
      const complete = async output => {
        const finding = validateFinding(JSON.parse(finalText(output)), request, [...records.values()], sources, this.store.now());
        if (finding.identity) {
          finding.relatedInvestigationIds = await this.store.related(finding.identity, job.id);
          if (finding.relatedInvestigationIds.length) await this.store.event(job.id, 'related_request', 'Another investigation identified this same registered system');
        }
        const state = finding.outcome === 'candidate' ? 'pending_verification' : finding.outcome === 'needs_details' ? 'waiting_for_details' : 'review';
        await this.store.finish(job.id, lease, state, finding);
        return await this.store.get(job.id);
      };

      // A crash after the final checkpoint must finish from saved evidence, not pay again.
      if (saved.response?.status === 'completed' && Array.isArray(saved.response.output)
        && !saved.response.output.some(item => item.type === 'function_call')) return await complete(saved.response.output);
      if (saved.round >= MAX_ROUNDS) throw new Error('Investigation reached its step limit; human review needed with collected evidence');
      assertPricingCurrent(this.store.now());
      if (!Number.isSafeInteger(this.config.limitMicros) || this.config.limitMicros <= 0 || this.config.limitMicros > MONTHLY_LIMIT_MICROS) {
        throw new Error('Invalid research budget configuration');
      }
      const reserved = reservationMicros(this.config.fx);
      if (Buffer.byteLength(JSON.stringify(input)) > 180_000) throw new Error('Investigation context reached its safe limit');
      await checkpoint(saved.round);
      if (!hasTime(PROVIDER_TIMEOUT_MS + 2 * REGISTRY_TIMEOUT_MS)) {
        await this.store.yield(job.id, lease);
        return await this.store.get(job.id);
      }
      const month = sydneyMonth(this.store.now());
      const budget = await this.store.budget(month);
      if (!Number.isSafeInteger(budget?.charged) || budget.charged < 0
        || !Number.isSafeInteger(budget?.reserved) || budget.reserved < 0
        || (month === INITIAL_SPENT_MONTH && budget.charged < INITIAL_SPENT_MICROS)) {
        throw new Error('Research budget ledger is invalid or missing the approved spent seed');
      }
      let reservation;
      try { reservation = await this.store.reserve(job.id, lease, reserved, this.config.limitMicros); }
      catch (error) {
        if (!/budget/i.test(error.message)) throw error;
        await this.store.finish(job.id, lease, 'budget_paused', { summary: error.message });
        return await this.store.get(job.id);
      }
      let response;
      try {
        // Recheck after potentially slow database calls, before sending a paid request.
        await checkpoint(saved.round);
        if (!hasTime(PROVIDER_TIMEOUT_MS + 2 * REGISTRY_TIMEOUT_MS)) {
          await this.store.rejected(reservation);
          await this.store.yield(job.id, lease);
          return await this.store.get(job.id);
        }
        assertPricingCurrent(this.store.now());
      } catch (error) {
        await this.store.rejected(reservation);
        throw error;
      }
      try { response = await this.provider.respond(input); }
      catch (error) {
        if (error.definitive) await this.store.rejected(reservation);
        else await this.store.uncertain(reservation);
        throw error;
      }
      let charge;
      let output;
      try {
        if (typeof response?.model !== 'string' || !new RegExp(`^${MODEL.replaceAll('.', '\\.')}($|-)`).test(response.model)) {
          throw new Error('Unexpected billed model; usage requires reconciliation');
        }
        if (!Array.isArray(response.output) || typeof response.id !== 'string' || !response.id) throw new Error('Missing auditable API response');
        output = response.output;
        charge = costMicros(response.usage, output.filter(x => x.type === 'web_search_call').length, this.config.fx);
      } catch (error) {
        await this.store.uncertain(reservation);
        throw error;
      }
      if (!await this.store.settle(reservation, charge, response.id)) throw new Error('API usage exceeded the reserved bound; further calls paused');
      await this.store.checkLease(job.id, lease);
      await this.store.event(job.id, 'api_usage', `Research step ${saved.round + 1}: A$${(charge / 1e6).toFixed(4)} conservatively accounted`);
      input.push(...output);
      collectedSources(output).forEach(url => sources.add(url));
      for (const item of output.filter(x => x.type === 'web_search_call')) {
        await this.store.event(job.id, 'web_research', item.action?.query || 'Primary-source search completed');
      }
      if (response.status !== 'completed') throw new Error('Agent response did not complete; findings are not approved');
      const calls = output.filter(x => x.type === 'function_call');
      if (calls.length > 2) throw new Error('Agent exceeded its bounded registry-tool allowance');
      const callIds = new Set();
      for (const call of calls) {
        await this.store.checkLease(job.id, lease);
        if (call.name !== 'search_registry' || typeof call.call_id !== 'string' || !call.call_id || callIds.has(call.call_id)) {
          throw new Error('Agent requested a tool outside its read-only permissions');
        }
        callIds.add(call.call_id);
        const args = JSON.parse(call.arguments);
        if (!args || Object.keys(args).length !== 1 || typeof args.code !== 'string') throw new Error('Invalid registry-tool arguments');
        const { code } = args;
        await this.store.event(job.id, 'registry_search', `Checking exact model code: ${code.slice(0, 100)}`);
        let result;
        try {
          if (!hasTime(REGISTRY_TIMEOUT_MS)) throw new Error('Registry deadline reached');
          result = await this.registry.search(code);
          sources.add(result.sourceUrl);
          if (!result.truncated) for (const record of result.records) records.set(JSON.stringify(record), record);
        } catch {
          result = { error: 'Official registry is temporarily unavailable; this is not evidence of no match. Try primary manufacturer research or explain the outstanding check.' };
        }
        input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
      // Advance only with the full billed response and every tool result durably stored.
      await checkpoint(saved.round + 1, response);
      if (!calls.length) return await complete(output);
      if (saved.round + 1 >= MAX_ROUNDS) throw new Error('Investigation reached its step limit; human review needed with collected evidence');
      await this.store.yield(job.id, lease);
      return await this.store.get(job.id);
    } catch (error) {
      const current = await this.store.get(job.id);
      if (current?.lease === lease && current.state === 'researching') {
        // Store mutations must also enforce the lease atomically, including its expiry.
        try {
          await this.store.finish(job.id, lease, 'review', { summary: error.message, collectedSources: [...sources], registrationsChecked: records.size });
        } catch (finishError) {
          const latest = await this.store.get(job.id);
          if (latest?.lease === lease && latest.state === 'researching') throw finishError;
        }
      }
      return await this.store.get(job.id);
    }
  }
}
