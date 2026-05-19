import test from "node:test";
import assert from "node:assert/strict";

import { evaluateProbabilitySide, loadProbabilityMap } from "../lib/probability-map.js";

const coarseMapPayload = {
  binning: {
    delta_points: ["0_19", "20_49", "50_99", "100_plus"],
    ret10_abs: ["0_9bp", "10_39bp", "40bp_plus"],
    trigger_volume_ratio_1m: ["lt_0_5x", "0_5x_1_2x", "1_2x_plus"],
    minutes_field: {
      YES: "above_mins",
      NO: "below_mins",
    },
    minutes_mode: "at_least",
  },
  map: {
    threshold: {
      YES: {
        "6": {
          "0_19": {
            all_ret10: {
              n: 1625,
              win_rate: 0.646769,
              wilson_lower_95: 0.623208,
            },
            ret10: {
              "0_9bp": {
                n: 520,
                win_rate: 0.705,
                wilson_lower_95: 0.664,
              },
            },
            volume: {
              "0_5x_1_2x": {
                "0_9bp": {
                  n: 444,
                  win_rate: 0.725225,
                  wilson_lower_95: 0.681904,
                },
                all_ret10: {
                  n: 900,
                  win_rate: 0.701111,
                  wilson_lower_95: 0.670123,
                },
              },
            },
          },
        },
        "10": {
          "20_49": {
            all_ret10: {
              n: 120,
              win_rate: 0.79,
              wilson_lower_95: 0.710001,
            },
            ret10: {
              "10_39bp": {
                n: 105,
                win_rate: 0.79,
                wilson_lower_95: 0.708,
              },
            },
            volume: {
              "1_2x_plus": {
                "10_39bp": {
                  n: 94,
                  win_rate: 0.829787,
                  wilson_lower_95: 0.741321,
                },
              },
            },
          },
        },
      },
      NO: {
        "8": {
          "0_19": {
            ret10: {
              "10_39bp": {
                n: 170,
                win_rate: 0.75,
                wilson_lower_95: 0.682,
              },
            },
            volume: {
              "lt_0_5x": {
                "10_39bp": {
                  n: 137,
                  win_rate: 0.773723,
                  wilson_lower_95: 0.697291,
                },
              },
            },
          },
        },
      },
    },
    fallback: {
      YES: {
        mins_at_least_6: {
          n: 2200,
          win_rate: 0.641,
          wilson_lower_95: 0.620001,
        },
      },
      NO: {
        mins_at_least_8: {
          n: 1900,
          win_rate: 0.788,
          wilson_lower_95: 0.769,
        },
      },
    },
  },
};

test("YES side passes when coarse model edge and support clear thresholds", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.41,
    features: {
      btcStart: 77915.32,
      btcTriggerPrice: 77916.24,
      aboveStartMinutes: 6,
      belowStartMinutes: 7,
      ret10mToTrigger: -0.000011,
      triggerVolumeRatio1m: 0.8,
    },
    mapPayload: coarseMapPayload,
    minEdge: 0.10,
    minProbability: 0.70,
    minSupport: 5,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.passes, true);
  assert.equal(result.probability, 0.725225);
  assert.equal(result.supportN, 444);
  assert.equal(result.source, "threshold_volume_boost");
  assert.equal(result.deltaBucket, "0_19");
  assert.equal(result.volumeBucket, "0_5x_1_2x");
  assert.equal(result.ret10Bucket, "0_9bp");
});

test("NO side fails when support is below minimum even with positive edge", async () => {
  const result = await evaluateProbabilitySide({
    side: "NO",
    entryPrice: 0.56,
    features: {
      btcStart: 100,
      btcTriggerPrice: 94.5,
      aboveStartMinutes: 2,
      belowStartMinutes: 8,
      ret10mToTrigger: -0.00011,
      triggerVolumeRatio1m: 0.2,
    },
    mapPayload: {
      ...coarseMapPayload,
      map: {
        ...coarseMapPayload.map,
        threshold: {
          ...coarseMapPayload.map.threshold,
          NO: {
            "8": {
              "0_19": {
                volume: {
                  "lt_0_5x": {
                    "10_39bp": { n: 5, win_rate: 0.8, wilson_lower_95: 0.376 },
                  },
                },
              },
            },
          },
        },
      },
    },
    minEdge: 0.10,
    minProbability: 0.70,
    minSupport: 10,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.passes, false);
  assert.equal(result.reason, "support_below_min");
  assert.equal(result.supportN, 5);
});

test("direction mismatch fails before map lookup", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.4,
    features: {
      btcStart: 100,
      btcTriggerPrice: 99,
      aboveStartMinutes: 4,
      belowStartMinutes: 9,
      ret10mToTrigger: -0.0002,
      triggerVolumeRatio1m: 0.8,
    },
    mapPayload: coarseMapPayload,
    minEdge: 0.10,
    minProbability: 0.70,
    minSupport: 10,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.passes, false);
  assert.equal(result.reason, "direction_mismatch");
});

test("can use conservative wilson probability field", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.68,
    features: {
      btcStart: 100,
      btcTriggerPrice: 134,
      aboveStartMinutes: 10,
      belowStartMinutes: 3,
      ret10mToTrigger: 0.00012,
      triggerVolumeRatio1m: 1.4,
    },
    mapPayload: coarseMapPayload,
    minEdge: 0.10,
    minProbability: 0.70,
    minSupport: 10,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "wilson_lower_95",
  });

  assert.equal(result.passes, false);
  assert.equal(result.reason, "edge_below_min");
  assert.equal(result.probability, 0.741321);
});

test("fails when probability is below the stricter minimum even if edge and support pass", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.41,
    features: {
      btcStart: 77915.32,
      btcTriggerPrice: 77916.24,
      aboveStartMinutes: 6,
      belowStartMinutes: 7,
      ret10mToTrigger: -0.000011,
      triggerVolumeRatio1m: 0.8,
    },
    mapPayload: {
      ...coarseMapPayload,
      map: {
        ...coarseMapPayload.map,
        threshold: {
          ...coarseMapPayload.map.threshold,
          YES: {
            "6": {
              "0_19": {
                all_ret10: {
                  n: 1625,
                  win_rate: 0.646769,
                  wilson_lower_95: 0.623208,
                },
                volume: {
                  "0_5x_1_2x": {
                    "0_9bp": {
                      n: 444,
                      win_rate: 0.625,
                      wilson_lower_95: 0.601,
                    },
                    all_ret10: {
                      n: 900,
                      win_rate: 0.68,
                      wilson_lower_95: 0.65,
                    },
                  },
                },
                ret10: {
                  "0_9bp": {
                    n: 520,
                    win_rate: 0.625,
                    wilson_lower_95: 0.601,
                  },
                },
              },
            },
          },
        },
      },
    },
    minEdge: 0.10,
    minProbability: 0.70,
    minSupport: 5,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.passes, false);
  assert.equal(result.reason, "probability_below_min");
  assert.equal(result.probability, 0.625);
  assert.ok(Math.abs(result.edge - 0.215) < 1e-12);
});

test("falls back to volume all_ret10 when the exact ret bucket is missing", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.50,
    features: {
      btcStart: 200,
      btcTriggerPrice: 209,
      aboveStartMinutes: 6,
      belowStartMinutes: 7,
      ret10mToTrigger: 0.0002,
      triggerVolumeRatio1m: 0.8,
    },
    mapPayload: coarseMapPayload,
    minEdge: 0.10,
    minProbability: 0.60,
    minSupport: 100,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.source, "threshold_volume_all_ret10_boost");
  assert.equal(result.probability, 0.701111);
});

test("falls back to delta all_ret10 when the volume bucket is missing", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.50,
    features: {
      btcStart: 200,
      btcTriggerPrice: 209,
      aboveStartMinutes: 6,
      belowStartMinutes: 7,
      ret10mToTrigger: 0.0002,
      triggerVolumeRatio1m: 2.0,
    },
    mapPayload: coarseMapPayload,
    minEdge: 0.10,
    minProbability: 0.60,
    minSupport: 100,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.source, "threshold_all_ret10");
  assert.equal(result.probability, 0.646769);
});

test("falls back to mins_at_least when no delta bucket entry exists", async () => {
  const result = await evaluateProbabilitySide({
    side: "NO",
    entryPrice: 0.70,
    features: {
      btcStart: 100,
      btcTriggerPrice: 96,
      aboveStartMinutes: 2,
      belowStartMinutes: 8,
      ret10mToTrigger: -0.0008,
      triggerVolumeRatio1m: 1.4,
    },
    mapPayload: {
      ...coarseMapPayload,
      map: {
        threshold: { YES: {}, NO: {} },
        fallback: coarseMapPayload.map.fallback,
      },
    },
    minEdge: 0.05,
    minProbability: 0.70,
    minSupport: 100,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.source, "mins_at_least");
  assert.equal(result.probability, 0.788);
});

test("fails when buy price is below the configured band", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.29,
    features: {
      btcStart: 77915.32,
      btcTriggerPrice: 77916.24,
      aboveStartMinutes: 6,
      belowStartMinutes: 7,
      ret10mToTrigger: -0.000011,
      triggerVolumeRatio1m: 0.8,
    },
    mapPayload: coarseMapPayload,
    minEdge: 0.10,
    minProbability: 0.70,
    minSupport: 5,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.passes, false);
  assert.equal(result.reason, "price_outside_band");
});

test("fails when buy price is above the configured band", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.71,
    features: {
      btcStart: 100,
      btcTriggerPrice: 134,
      aboveStartMinutes: 10,
      belowStartMinutes: 3,
      ret10mToTrigger: 0.00012,
      triggerVolumeRatio1m: 1.4,
    },
    mapPayload: coarseMapPayload,
    minEdge: 0.10,
    minProbability: 0.70,
    minSupport: 10,
    minBuyPrice: 0.30,
    maxBuyPrice: 0.70,
    probabilityField: "win_rate",
  });

  assert.equal(result.passes, false);
  assert.equal(result.reason, "price_outside_band");
});

test("coarse loader rejects legacy map format", async () => {
  const tmpPath = new URL("../tmp-legacy-probability-map.json", import.meta.url);
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(tmpPath, JSON.stringify({ map: { exact: {} } }), "utf8");
  await assert.rejects(
    () => loadProbabilityMap(tmpPath),
    /Unsupported probability map format/,
  );
  await rm(tmpPath, { force: true });
});
