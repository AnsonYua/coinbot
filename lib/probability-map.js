import { readFile } from "node:fs/promises";

let cachedMapPath = "";
let cachedMapPromise = null;

const DELTA_BINS = [
  [0, 20, "0_19"],
  [20, 50, "20_49"],
  [50, 100, "50_99"],
  [100, Number.POSITIVE_INFINITY, "100_plus"],
];

const RET10_BINS = [
  [0, 0.0001, "0_9bp"],
  [0.0001, 0.0004, "10_39bp"],
  [0.0004, Number.POSITIVE_INFINITY, "40bp_plus"],
];

function getBin(value, bins) {
  for (const [lo, hi, label] of bins) {
    if (value >= lo && value < hi) return label;
  }
  return bins[bins.length - 1]?.[2] ?? null;
}

function selectStats(payload, side, mins, deltaBucket, ret10Bucket) {
  const map = payload?.map;
  if (!map) return { stats: null, source: null };

  const threshold = map.threshold?.[side]?.[String(mins)]?.[deltaBucket]?.[ret10Bucket];
  if (threshold) return { stats: threshold, source: "threshold" };

  const thresholdAllRet10 = map.threshold?.[side]?.[String(mins)]?.[deltaBucket]?.all_ret10;
  if (thresholdAllRet10) return { stats: thresholdAllRet10, source: "threshold_all_ret10" };

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
    .then((text) => {
      const payload = JSON.parse(text);
      if (payload?.binning?.minutes_mode !== "at_least" || !payload?.map?.threshold) {
        throw new Error(`Unsupported probability map format in ${mapPath}; expected coarse threshold map`);
      }
      return payload;
    })
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
  minProbability,
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
  const payload = mapPayload || await loadProbabilityMap(mapPath);
  const deltaBucket = getBin(Math.abs(deltaPoints), DELTA_BINS);
  const ret10Bucket = getBin(Math.abs(features.ret10mToTrigger), RET10_BINS);
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
  const probabilityPasses = probability >= minProbability;
  const edgePasses = edge >= minEdge;
  const supportPasses = supportN >= minSupport;
  return {
    side,
    passes: probabilityPasses && edgePasses && supportPasses,
    reason: !probabilityPasses
      ? "probability_below_min"
      : !edgePasses
        ? "edge_below_min"
        : !supportPasses
          ? "support_below_min"
          : "passed",
    probability,
    edge,
    supportN,
    source,
    mins,
    deltaPoints,
    deltaBucket,
    ret10Bucket,
    probabilityField,
    minProbability,
    minEdge,
    minSupport,
  };
}
