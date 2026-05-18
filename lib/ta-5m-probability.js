import { readFile } from "node:fs/promises";

export const TA_5M_MODEL_SOURCE = "btc_5m_ta_probability_map_90d";
export const TA_5M_MIN_ENTRY_PRICE = 0.30;
export const TA_5M_MAX_ENTRY_PRICE = 0.55;
export const TA_5M_MIN_CONSERVATIVE_EDGE = 0.08;
export const TA_5M_MIN_SUPPORT = 25;

let cachedPath = "";
let cachedPromise = null;

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function close(row) {
  return Number(row?.[4]);
}

function open(row) {
  return Number(row?.[1]);
}

function ema(values, period) {
  if (values.length < period) return null;
  const weight = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    value = (values[index] * weight) + (value * (1 - weight));
  }
  return value;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) {
      gains += delta;
    } else {
      losses -= delta;
    }
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - (100 / (1 + relativeStrength));
}

function stdev(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
  return Math.sqrt(values.reduce((sum, item) => sum + ((item - mean) ** 2), 0) / values.length);
}

function direction(value, epsilon = 0) {
  if (value > epsilon) return "up";
  if (value < -epsilon) return "down";
  return "flat";
}

function bin(value, cuts, labels) {
  for (let index = 0; index < cuts.length; index += 1) {
    if (value < cuts[index]) return labels[index];
  }
  return labels[labels.length - 1];
}

export function build5mTaFeatures(rawCandles) {
  if (!Array.isArray(rawCandles) || rawCandles.length < 64) {
    throw new Error(`Expected at least 64 BTC 1m candles for TA features, got ${Array.isArray(rawCandles) ? rawCandles.length : "invalid"}`);
  }
  const rows = rawCandles.slice(0, 64);
  const startPrice = open(rows[60]);
  const previousMinuteClose = close(rows[62]);
  const triggerPrice = close(rows[63]);
  if (!(startPrice > 0) || !(previousMinuteClose > 0) || !(triggerPrice > 0)) {
    throw new Error("Invalid BTC candle prices for 5m TA features");
  }

  const closesToTrigger = rows.map(close);
  const ema5 = ema(closesToTrigger, 5);
  const ema20 = ema(closesToTrigger, 20);
  const last20 = closesToTrigger.slice(-20);
  const mean20 = last20.reduce((sum, item) => sum + item, 0) / last20.length;
  const stdev20 = stdev(last20);
  const btcRsi14 = rsi(closesToTrigger, 14);
  const btcEmaTrend = ema5 != null && ema20 != null ? (ema5 / ema20) - 1 : null;
  const btcBollingerZ20 = stdev20 && stdev20 > 0 ? (triggerPrice - mean20) / stdev20 : 0;
  const btcDistance = (triggerPrice / startPrice) - 1;
  const btcMomentum60 = (triggerPrice / previousMinuteClose) - 1;

  return {
    btcStart: startPrice,
    btcTriggerPrice: triggerPrice,
    btcDistance,
    btcMomentum60,
    btcRsi14,
    btcEmaTrend,
    btcBollingerZ20,
    rawCandles: rows,
  };
}

export function taBucketKey(features, source) {
  if (source === "balanced") {
    return [
      direction(features.btcDistance, 0.00005),
      bin(Math.abs(features.btcDistance), [0.00015, 0.0003, 0.0007, 0.0012], ["d0", "d1", "d2", "d3", "d4"]),
      direction(features.btcMomentum60, 0.00003),
      bin(Math.abs(features.btcMomentum60), [0.0001, 0.00025, 0.0005], ["m0", "m1", "m2", "m3"]),
      features.btcRsi14 < 40 ? "rlo" : features.btcRsi14 > 60 ? "rhi" : "rmid",
      features.btcEmaTrend > 0.00005 ? "tup" : features.btcEmaTrend < -0.00005 ? "tdn" : "tfl",
      features.btcBollingerZ20 > 1 ? "zhi" : features.btcBollingerZ20 < -1 ? "zlo" : "zmid",
    ].join("|");
  }
  if (source === "coarse") {
    return [
      direction(features.btcDistance, 0.00005),
      bin(Math.abs(features.btcDistance), [0.0002, 0.0007], ["ds", "dm", "db"]),
      direction(features.btcMomentum60, 0.00003),
      features.btcRsi14 < 45 ? "rlo" : features.btcRsi14 > 55 ? "rhi" : "rmid",
      features.btcEmaTrend > 0 ? "tup" : "tdn",
    ].join("|");
  }
  return [
    direction(features.btcDistance, 0.00005),
    bin(Math.abs(features.btcDistance), [0.00025, 0.0007], ["ds", "dr", "de"]),
    direction(features.btcMomentum60, 0.00003),
  ].join("|");
}

export async function load5mTaProbabilityMap(mapPath) {
  if (cachedPromise && cachedPath === mapPath) {
    return cachedPromise;
  }
  cachedPath = mapPath;
  cachedPromise = readFile(mapPath, "utf8")
    .then((text) => {
      const payload = JSON.parse(text);
      if (!payload?.buckets?.balanced || !payload?.global) {
        throw new Error(`Unsupported 5m TA probability map format in ${mapPath}`);
      }
      return payload;
    })
    .catch((error) => {
      if (cachedPath === mapPath) {
        cachedPath = "";
        cachedPromise = null;
      }
      throw error;
    });
  return cachedPromise;
}

function sideStats(bucket, side) {
  if (!bucket) return null;
  const wins = side === "YES" ? bucket.up_wins : bucket.down_wins;
  const probability = side === "YES" ? bucket.up_probability : bucket.down_probability;
  const conservativeProbability = side === "YES" ? bucket.up_wilson_lower_68 : bucket.down_wilson_lower_68;
  return {
    wins: asNumber(wins),
    probability: asNumber(probability),
    conservativeProbability: asNumber(conservativeProbability),
    supportN: asNumber(bucket.n),
  };
}

export function evaluate5mTaSide({
  side,
  entryPrice,
  features,
  mapPayload,
  minEntryPrice = TA_5M_MIN_ENTRY_PRICE,
  maxEntryPrice = TA_5M_MAX_ENTRY_PRICE,
  minConservativeEdge = TA_5M_MIN_CONSERVATIVE_EDGE,
  minSupport = TA_5M_MIN_SUPPORT,
}) {
  if (entryPrice == null || !Number.isFinite(entryPrice)) {
    return { side, passes: false, reason: "missing_buy_price" };
  }
  if (!features) {
    return { side, passes: false, reason: "missing_btc_features" };
  }
  if (entryPrice < minEntryPrice || entryPrice > maxEntryPrice) {
    return {
      side,
      passes: false,
      reason: "price_outside_band",
      minEntryPrice,
      maxEntryPrice,
    };
  }

  const lookupOrder = mapPayload.lookup_order || [
    { source: "balanced", min_support: 25 },
    { source: "coarse", min_support: 50 },
    { source: "simple", min_support: 80 },
    { source: "global", min_support: 0 },
  ];

  let selected = null;
  for (const lookup of lookupOrder) {
    const source = lookup.source;
    const bucket = source === "global"
      ? mapPayload.global
      : mapPayload.buckets?.[source]?.[taBucketKey(features, source)];
    const stats = sideStats(bucket, side);
    if (stats && stats.supportN >= lookup.min_support) {
      selected = {
        ...stats,
        bucketSource: source,
        bucket: source === "global" ? "global" : taBucketKey(features, source),
      };
      break;
    }
  }

  if (!selected) {
    return { side, passes: false, reason: "missing_probability_bucket" };
  }

  const edge = selected.probability - entryPrice;
  const conservativeEdge = selected.conservativeProbability - entryPrice;
  const supportPasses = selected.supportN >= minSupport;
  const edgePasses = conservativeEdge >= minConservativeEdge;
  return {
    side,
    passes: supportPasses && edgePasses,
    reason: !supportPasses
      ? "support_below_min"
      : !edgePasses
        ? "conservative_edge_below_min"
        : "ta_edge_passed",
    probability: selected.probability,
    conservativeProbability: selected.conservativeProbability,
    edge,
    conservativeEdge,
    supportN: selected.supportN,
    bucket: selected.bucket,
    bucketSource: selected.bucketSource,
    minEntryPrice,
    maxEntryPrice,
    minConservativeEdge,
    minSupport,
  };
}
