#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  TA_5M_MAX_ENTRY_PRICE,
  TA_5M_MIN_CONSERVATIVE_EDGE,
  TA_5M_MIN_ENTRY_PRICE,
  TA_5M_MIN_SUPPORT,
  build5mTaFeatures,
  taBucketKey,
} from "../lib/ta-5m-probability.js";

const execFileAsync = promisify(execFile);
const MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * MINUTE_MS;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(PROJECT_ROOT, "data", "btc_5m_ta_probability_map_90d.json");
const MODEL_SOURCE = "btc_5m_ta_probability_map_90d";
const STRATEGY_NAME = "btc_5m_ta_v2";
const SOURCE_NAMES = ["balanced_vol_v4", "coarse_vol_v4", "balanced", "coarse", "simple"];
const LOOKUP_ORDER = [
  { source: "balanced_vol_v4", min_support: 15 },
  { source: "coarse_vol_v4", min_support: 25 },
  { source: "balanced", min_support: 25 },
  { source: "coarse", min_support: 50 },
  { source: "simple", min_support: 80 },
  { source: "global", min_support: 0 },
];

function parseArgs(argv) {
  const args = {
    cacheFile: "",
    out: DEFAULT_OUT,
    skipFetch: false,
    forceFetch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--cache-file") {
      args.cacheFile = argv[index + 1] || "";
      index += 1;
    } else if (item === "--out") {
      args.out = argv[index + 1] || DEFAULT_OUT;
      index += 1;
    } else if (item === "--skip-fetch") {
      args.skipFetch = true;
    } else if (item === "--force-fetch") {
      args.forceFetch = true;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

function iso(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function rowOpenMs(row) {
  return Number(row?.[0]);
}

function rowClose(row) {
  return Number(row?.[4]);
}

function wilsonLower(wins, n, z = 1) {
  if (n <= 0) return 0;
  const phat = wins / n;
  const z2 = z * z;
  return (
    phat +
    z2 / (2 * n) -
    z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
  ) / (1 + z2 / n);
}

function createStats() {
  return {
    n: 0,
    up_wins: 0,
    down_wins: 0,
  };
}

function addSample(stats, upWon) {
  stats.n += 1;
  if (upWon) {
    stats.up_wins += 1;
  } else {
    stats.down_wins += 1;
  }
}

function finalizeStats(stats) {
  const upProbability = stats.n > 0 ? stats.up_wins / stats.n : 0;
  const downProbability = stats.n > 0 ? stats.down_wins / stats.n : 0;
  return {
    n: stats.n,
    up_wins: stats.up_wins,
    down_wins: stats.down_wins,
    up_probability: upProbability,
    down_probability: downProbability,
    up_wilson_lower_68: wilsonLower(stats.up_wins, stats.n),
    down_wilson_lower_68: wilsonLower(stats.down_wins, stats.n),
  };
}

function addBucketSample(buckets, source, key, upWon) {
  if (!buckets[source][key]) {
    buckets[source][key] = createStats();
  }
  addSample(buckets[source][key], upWon);
}

async function fetchCacheFile(forceFetch) {
  const args = ["scripts/cache_binance_btc_1m.py", "--days", "91"];
  if (forceFetch) args.push("--force");
  const { stdout } = await execFileAsync("python3", args, {
    cwd: PROJECT_ROOT,
    maxBuffer: 1024 * 1024 * 16,
  });
  const payload = JSON.parse(stdout);
  const cacheFile = payload?.results?.[0]?.cache_file;
  if (!cacheFile) {
    throw new Error("Binance cache refresh did not return a cache_file");
  }
  return cacheFile;
}

function buildMap(candles) {
  const candlesByOpen = new Map(candles.map((row) => [rowOpenMs(row), row]));
  const openTimes = candles.map(rowOpenMs).filter(Number.isFinite).sort((a, b) => a - b);
  if (openTimes.length === 0) {
    throw new Error("No candles found in cache file");
  }

  const lastCloseMs = openTimes[openTimes.length - 1] + MINUTE_MS;
  const endMs = Math.floor(lastCloseMs / FIVE_MINUTE_MS) * FIVE_MINUTE_MS;
  const startMs = endMs - (90 * DAY_MS);
  const buckets = Object.fromEntries(SOURCE_NAMES.map((source) => [source, {}]));
  const globalStats = createStats();
  let samples = 0;
  let missing = 0;

  for (let marketStartMs = startMs; marketStartMs < endMs; marketStartMs += FIVE_MINUTE_MS) {
    const rawCandles = [];
    for (let offset = -60; offset <= 3; offset += 1) {
      const row = candlesByOpen.get(marketStartMs + (offset * MINUTE_MS));
      if (!row) break;
      rawCandles.push(row);
    }
    const finalRow = candlesByOpen.get(marketStartMs + (4 * MINUTE_MS));
    if (rawCandles.length !== 64 || !finalRow) {
      missing += 1;
      continue;
    }

    const features = build5mTaFeatures(rawCandles);
    const finalClose = rowClose(finalRow);
    if (!(finalClose > 0)) {
      missing += 1;
      continue;
    }
    const upWon = finalClose > features.btcStart;
    addSample(globalStats, upWon);
    for (const source of SOURCE_NAMES) {
      addBucketSample(buckets, source, taBucketKey(features, source), upWon);
    }
    samples += 1;
  }

  const expectedSamples = 90 * 24 * 12;
  if (samples !== expectedSamples || missing !== 0) {
    throw new Error(`Expected ${expectedSamples} complete 5m samples, got ${samples} with ${missing} missing`);
  }

  const finalizedBuckets = {};
  for (const source of SOURCE_NAMES) {
    finalizedBuckets[source] = Object.fromEntries(
      Object.entries(buckets[source])
        .map(([key, stats]) => [key, finalizeStats(stats)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  return {
    generated_at_utc: new Date().toISOString().replace(".000Z", "Z"),
    source: MODEL_SOURCE,
    source_data: "binance_btcusdt_1m",
    strategy: {
      name: STRATEGY_NAME,
      min_entry_price: TA_5M_MIN_ENTRY_PRICE,
      max_entry_price: TA_5M_MAX_ENTRY_PRICE,
      min_conservative_edge: TA_5M_MIN_CONSERVATIVE_EDGE,
      min_support: TA_5M_MIN_SUPPORT,
      trigger_offset_seconds: 240,
      volume_feature: "btc_volume_4m_ratio",
    },
    window: {
      start_utc: iso(startMs),
      end_utc: iso(endMs),
      days: 90,
      samples,
      missing,
    },
    binning: {
      trigger_distance: "direction + absolute move buckets",
      trigger_momentum_60: "direction + absolute 1m move buckets",
      rsi_14: "low/mid/high",
      ema_trend: "ema5 vs ema20",
      bollinger_z20: "low/mid/high",
      volume_4m_ratio: "quote volume for minute 0-3 divided by previous 60m average quote volume",
    },
    lookup_order: LOOKUP_ORDER,
    global: finalizeStats(globalStats),
    buckets: finalizedBuckets,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cacheFile = args.cacheFile || (args.skipFetch ? "" : await fetchCacheFile(args.forceFetch));
  if (!cacheFile) {
    throw new Error("Provide --cache-file when using --skip-fetch");
  }
  const resolvedCacheFile = path.isAbsolute(cacheFile) ? cacheFile : path.join(PROJECT_ROOT, cacheFile);
  const resolvedOut = path.isAbsolute(args.out) ? args.out : path.join(PROJECT_ROOT, args.out);
  const candles = JSON.parse(await readFile(resolvedCacheFile, "utf8"));
  const payload = buildMap(candles);
  payload.cache_file = resolvedCacheFile;
  await mkdir(path.dirname(resolvedOut), { recursive: true });
  await writeFile(resolvedOut, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: resolvedOut,
    cache_file: payload.cache_file,
    samples: payload.window.samples,
    window: payload.window,
    bucket_sources: Object.keys(payload.buckets),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
