import assert from "node:assert/strict";
import {
  aggregateCostSummary,
  deduplicateRecords,
  mapRecordToPool,
} from "../server/costEstimator";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  parseOpenRouterRateTable,
  parseRateTable,
  priceUsage,
} from "../server/usagePricing";
import {
  antigravityRateModel,
  initialCodexScanState,
  parseClaudeLine,
  parseCodexLine,
  parsePiLine,
  type UsageRecord,
} from "../server/usageScanner";

// 1. Rate table parsing: first-party priority, context tiers, speed tiers, 1h cache
const doc = {
  "anthropic/claude-sonnet-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 0.3e-6,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 22.5e-6,
    provider_specific_entry: { fast: 2 },
  },
  "openrouter/claude-sonnet-5": {
    input_cost_per_token: 99e-6,
    output_cost_per_token: 99e-6,
  },
  "openai/gpt-6.2-sol": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.25e-6,
    input_cost_per_token_priority: 5e-6,
    output_cost_per_token_priority: 20e-6,
  },
};

const table = parseRateTable(doc);
const sonnetRate = lookupRate(table, "claude-sonnet-5[1m]");
assert.ok(sonnetRate, "first-party bare alias should resolve and strip [1m] suffix");
assert.equal(sonnetRate.inputCostPerToken, 3e-6, "first-party beats reseller");
assert.equal(sonnetRate.fast?.inputCostPerToken, 6e-6, "fast multiplier applied");
assert.equal(sonnetRate.contextTiers.length, 1, "200k context tier parsed");
assert.equal(lookupRate(table, "<synthetic>"), null, "synthetic is unpriceable");

// 2. Pricing calculation: standard, 1h cache, >200k tier, fast premium, cache savings
const stdRec: UsageRecord = {
  provider: "claude",
  timestampMs: 1_700_000_000_000,
  model: "claude-sonnet-5",
  sessionId: "s1",
  totals: {
    uncachedInputTokens: 10_000,
    cachedInputTokens: 100_000,
    cacheCreationTokens: 20_000,
    outputTokens: 5_000,
    reasoningTokens: 0,
  },
  cacheCreation1hTokens: 5_000,
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: "k1",
};
const pricedStd = priceUsage(table, stdRec);
assert.equal(pricedStd.costSource, "modelPriced");
assert.equal(pricedStd.speedPremiumUsd, 0);
// 10k*3e-6 (0.03) + 100k*0.3e-6 (0.03) + 15k*3.75e-6 (0.05625) + 5k*6e-6 (0.03) + 5k*15e-6 (0.075) = 0.22125
assert.ok(Math.abs(pricedStd.costUsd - 0.22125) < 1e-9, `unexpected cost ${pricedStd.costUsd}`);
// Cache savings: 100k * (3e-6 - 0.3e-6) = 0.27
assert.ok(Math.abs(cacheSavingsUsd(table, stdRec) - 0.27) < 1e-9);

// Fast speed premium should equal standard cost (2x fast multiplier -> +1x premium)
const pricedFast = priceUsage(table, { ...stdRec, speed: "fast" });
assert.ok(Math.abs(pricedFast.costUsd - 0.4425) < 1e-9);
assert.ok(Math.abs(pricedFast.speedPremiumUsd - 0.22125) < 1e-9);

// Context tier (>200k prompt tokens)
const pricedLarge = priceUsage(table, {
  ...stdRec,
  totals: { ...stdRec.totals, cachedInputTokens: 250_000 },
  cacheCreation1hTokens: 0,
});
assert.ok(pricedLarge.costUsd > pricedStd.costUsd, "above-200k context tier should cost more");

// Custom override table
const overrides = createOverrideRateTable({
  "custom-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 },
});
const pricedCustom = priceUsage(
  table,
  {
    ...stdRec,
    model: "custom-model",
    totals: { uncachedInputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 500_000, reasoningTokens: 0 },
    cacheCreation1hTokens: 0,
  },
  overrides
);
assert.ok(Math.abs(pricedCustom.costUsd - 2.0) < 1e-9);

// 3. Claude JSONL parser (including advisor iteration)
const claudeLine = JSON.stringify({
  type: "assistant",
  timestamp: "2026-11-26T08:00:00.000Z",
  requestId: "req_1",
  sessionId: "sess_1",
  message: {
    id: "msg_1",
    model: "claude-sonnet-5",
    usage: {
      input_tokens: 1000,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
      output_tokens: 500,
      cache_creation: { ephemeral_1h_input_tokens: 500 },
      iterations: [
        {
          type: "advisor_message",
          model: "claude-opus-5-5",
          input_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 100,
        },
      ],
    },
  },
});
const claudeRecs = parseClaudeLine(claudeLine);
assert.equal(claudeRecs.length, 2);
assert.equal(claudeRecs[0]!.cacheCreation1hTokens, 500);
assert.equal(claudeRecs[1]!.model, "claude-opus-5-5");

// 4. Codex JSONL parser (subtracts cached from input_tokens, tracks service_tier)
const codexState = initialCodexScanState();
assert.equal(
  parseCodexLine(
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-11-26T08:00:00.000Z",
      payload: { id: "cx_1", model_provider: "openai" },
    }),
    codexState
  ).length,
  0
);
assert.equal(
  parseCodexLine(
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-11-26T08:00:01.000Z",
      payload: { model: "gpt-6.2-sol", turn_id: "t1" },
    }),
    codexState
  ).length,
  0
);
assert.equal(
  parseCodexLine(
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-11-26T08:00:01.500Z",
      payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } },
    }),
    codexState
  ).length,
  0
);
const codexRecs = parseCodexLine(
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-11-26T08:00:05.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10_000,
          cached_input_tokens: 8_000,
          output_tokens: 1_000,
          reasoning_output_tokens: 400,
          total_tokens: 11_000,
        },
        total_token_usage: {
          input_tokens: 10_000,
          cached_input_tokens: 8_000,
          output_tokens: 1_000,
          reasoning_output_tokens: 400,
          total_tokens: 11_000,
        },
      },
    },
  }),
  codexState
);
assert.equal(codexRecs.length, 1);
assert.equal(codexRecs[0]!.totals.uncachedInputTokens, 2_000);
assert.equal(codexRecs[0]!.totals.cachedInputTokens, 8_000);
assert.equal(codexRecs[0]!.speed, "fast");

// 5. Pi JSONL parser
const piState = { sessionId: "" };
parsePiLine(JSON.stringify({ type: "session", id: "pi_sess_1" }), piState);
const piRecs = parsePiLine(
  JSON.stringify({
    type: "message",
    id: "m1",
    timestamp: "2026-11-26T08:01:00.000Z",
    message: {
      role: "assistant",
      provider: "zai-coding-cn",
      model: "glm-5.4",
      usage: { input: 5000, cacheRead: 2000, cacheWrite: 0, output: 1000, cost: { total: 0 } },
    },
  }),
  piState
);
assert.equal(piRecs.length, 1);
assert.equal(piRecs[0]!.model, "zai-coding-cn/glm-5.4");
assert.equal(piRecs[0]!.rateModel, "glm-5.4");
assert.equal(piRecs[0]!.reportedCostUsd, null, "zero transcript cost falls back to model rates");
assert.equal(mapRecordToPool(piRecs[0]!), "glm");

// 6. Antigravity rate model normalization & deduplication + aggregation
assert.equal(antigravityRateModel("gemini-3.8-flash-high"), "gemini-3.8-flash");
assert.equal(antigravityRateModel("gemini-4-hydrogen-tiered-high"), "gemini-4-hydrogen");
assert.equal(antigravityRateModel("gemini-pro-orchestrator-neon"), "gemini-4-neon");
assert.equal(mapRecordToPool({ provider: "antigravity", model: "gemini-4-neon" }), "antigravity:gemini");
assert.equal(mapRecordToPool({ provider: "antigravity", model: "claude-opus-5-5" }), "antigravity:3p");

const dupA: UsageRecord = { ...stdRec, totals: { ...stdRec.totals, outputTokens: 100 } };
const dupB: UsageRecord = { ...stdRec, totals: { ...stdRec.totals, outputTokens: 5000 } };
const deduped = deduplicateRecords([dupA, dupB]);
assert.equal(deduped.length, 1);
assert.equal(deduped[0]!.totals.outputTokens, 5000);

const summary = aggregateCostSummary([...claudeRecs, ...codexRecs, ...piRecs], table, "7d", null);
assert.ok(summary.totalCostUsd > 0, "aggregate cost should be positive");
assert.equal(summary.byPool.length, 3, "claude, codex, glm pools represented");

// 7. OpenRouter fallback rate table parser (skips :batch, parses overrides context tiers)
const orTable = parseOpenRouterRateTable({
  data: [
    {
      id: "openai/gpt-6.2-astra",
      pricing: {
        prompt: "0.000008",
        completion: "0.00004",
        input_cache_read: "0.0000004",
        input_cache_write: "0.00001",
        overrides: [
          {
            min_prompt_tokens: 272000,
            prompt: "0.000016",
            completion: "0.00006",
            input_cache_read: "0.0000008",
            input_cache_write: "0.00002",
          },
        ],
      },
    },
    {
      id: "openai/gpt-6.2-astra:batch",
      pricing: { prompt: "0.000004", completion: "0.00002" },
    },
  ],
});
const astraRate = lookupRate(orTable, "gpt-6.2-astra");
assert.ok(astraRate, "OpenRouter bare model alias should resolve");
assert.equal(astraRate.inputCostPerToken, 8e-6, ":batch variant must not overwrite canonical price");
assert.equal(astraRate.contextTiers.length, 1, "OpenRouter min_prompt_tokens override parsed");
assert.equal(astraRate.contextTiers[0]!.thresholdTokens, 272_000);
assert.equal(lookupRate(orTable, "openai/gpt-6.2-astra:batch"), null, ":batch variant skipped");

console.log("ALL USAGE COST CHECKS PASSED");
