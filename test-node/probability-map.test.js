import test from "node:test";
import assert from "node:assert/strict";

import { evaluateProbabilitySide } from "../lib/probability-map.js";

const mapPayload = {
  map: {
    exact: {
      YES: {
        "10": {
          "30_39": {
            "10_19bp": {
              n: 41,
              win_rate: 0.829268,
              wilson_lower_95: 0.688,
            },
          },
        },
      },
      NO: {
        "11": {
          "0_9": {
            "10_19bp": {
              n: 22,
              win_rate: 0.727273,
              wilson_lower_95: 0.514,
            },
          },
        },
      },
    },
    fallback: {
      YES: {},
      NO: {},
    },
  },
};

test("YES side passes when model edge and support clear thresholds", async () => {
  const result = await evaluateProbabilitySide({
    side: "YES",
    entryPrice: 0.68,
    features: {
      btcStart: 100,
      btcTriggerPrice: 134,
      aboveStartMinutes: 10,
      belowStartMinutes: 3,
      ret10mToTrigger: 0.00012,
    },
    mapPayload,
    minEdge: 0.10,
    minSupport: 10,
    probabilityField: "win_rate",
  });

  assert.equal(result.passes, true);
  assert.equal(result.probability, 0.829268);
  assert.equal(result.supportN, 41);
  assert.equal(result.source, "exact");
});

test("NO side fails when support is below minimum even with positive edge", async () => {
  const result = await evaluateProbabilitySide({
    side: "NO",
    entryPrice: 0.56,
    features: {
      btcStart: 100,
      btcTriggerPrice: 94.5,
      aboveStartMinutes: 2,
      belowStartMinutes: 11,
      ret10mToTrigger: -0.00011,
    },
    mapPayload: {
      map: {
        exact: {
          NO: {
            "11": {
              "0_9": {
                "10_19bp": {
                  n: 5,
                  win_rate: 0.8,
                  wilson_lower_95: 0.376,
                },
              },
            },
          },
        },
        fallback: { YES: {}, NO: {} },
      },
    },
    minEdge: 0.10,
    minSupport: 10,
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
    },
    mapPayload,
    minEdge: 0.10,
    minSupport: 10,
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
    },
    mapPayload,
    minEdge: 0.10,
    minSupport: 10,
    probabilityField: "wilson_lower_95",
  });

  assert.equal(result.passes, false);
  assert.equal(result.reason, "edge_below_min");
  assert.equal(result.probability, 0.688);
});
