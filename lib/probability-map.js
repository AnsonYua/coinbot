import { readFile } from "node:fs/promises";

const DELTA_BINS = [
  [0, 10, "0_9"],
  [10, 20, "10_19"],
  [20, 30, "20_29"],
  [30, 40, "30_39"],
  [40, 50, "40_49"],
  [50, 75, "50_74"],
  [75, 100, "75_99"],
  [100, 150, "100_149"],
  [150, Number.POSITIVE_INFINITY, "150_plus"],
];

const RET10_BINS = [
  [0, 0.00005, "0_4bp"],
  [0.00005, 0.0001, "5_9bp"],
  [0.0001, 0.0002, "10_19bp"],
  [0.0002, 0.0004, "20_39bp"],
  [0.0004, Number.POSITIVE_INFINITY, "40bp_plus"],
];

let cachedMapPath = "";
let cachedMapPromise = null;

function getBin(value, bins) {
  for (const [lo, hi, label] of bins) {
    if (value >= lo && value < hi) return label;
  }
  return bins[bins.length - 1][2];
}

function selectStats(payload, side, mins, deltaBucket, ret10Bucket) {
  const map = payload?.map;
  if (!map) return { stats: null, source: null };

  const exact = map.exact?.[side]?.[String(mins)]?.[deltaBucket]?.[ret10Bucket];
  if (exact) return { stats: exact, source: "exact" };

  const deltaAllRet10 = map.exact?.[side]?.[String(mins)]?.[deltaBucket]?.all_ret10;
  if (deltaAllRet10) return { stats: deltaAllRet10, source: "delta_all_ret10" };

  const minsExact = map.fallback?.[side]?.[`mins_exact_${mins}`];
  if (minsExact) return { stats: minsExact, source: "mins_exact" };

  const minsAtLeast = map.fallback?.[side]?.[`mins_at_least_${mins}`];
  if (minsAtLeast) return { stats: minsAtLeast, source: "mins_at_least" };

  return { stats: null, source: null };
}

export async function loadProbabilityMap(mapPath) {
  if (cachedMapPromise && cachedMapPath === mapPath) {
    return cachedMapPromise;
  }
  cachedMapPath = mapPath;
  cachedMapPromise = readFile(mapPath, "utf8")
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (cachedMapPath === mapPath) {
        cachedMapPath = "";
        cachedMapPromise = null;
      }
      throw error;
    });
  return cachedMapPromise;
}

export async function evaluateProbabilitySide({
  side,
  entryPrice,
  features,
  mapPath,
  minEdge,
  minSupport,
  probabilityField,
  mapPayload,
}) {
  if (entryPrice == null) {
    return {
      side,
      passes: false,
      reason: "missing_buy_price",
    };
  }

  const deltaPoints = features.btcTriggerPrice - features.btcStart;
  const detectedSide = deltaPoints > 0 ? "YES" : deltaPoints < 0 ? "NO" : "FLAT";
  if (detectedSide !== side) {
    return {
      side,
      passes: false,
      reason: "direction_mismatch",
      detectedSide,
      deltaPoints,
    };
  }

  const mins = side === "YES" ? features.aboveStartMinutes : features.belowStartMinutes;
  const deltaBucket = getBin(Math.abs(deltaPoints), DELTA_BINS);
  const ret10Bucket = getBin(Math.abs(features.ret10mToTrigger), RET10_BINS);
  const payload = mapPayload || await loadProbabilityMap(mapPath);
  const { stats, source } = selectStats(payload, side, mins, deltaBucket, ret10Bucket);
  if (!stats) {
    return {
      side,
      passes: false,
      reason: "missing_probability_bucket",
      mins,
      deltaBucket,
      ret10Bucket,
    };
  }

  const probability = Number(stats?.[probabilityField]);
  const supportN = Number(stats?.n || 0);
  if (!Number.isFinite(probability)) {
    return {
      side,
      passes: false,
      reason: "invalid_probability_value",
      source,
      supportN,
    };
  }

  const edge = probability - entryPrice;
  return {
    side,
    passes: edge >= minEdge && supportN >= minSupport,
    reason: edge >= minEdge ? (supportN >= minSupport ? "passed" : "support_below_min") : "edge_below_min",
    probability,
    edge,
    supportN,
    source,
    mins,
    deltaPoints,
    deltaBucket,
    ret10Bucket,
    probabilityField,
    minEdge,
    minSupport,
  };
}
