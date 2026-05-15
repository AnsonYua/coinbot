import test from "node:test";
import assert from "node:assert/strict";

import { evaluateYesRule, evaluateNoRule } from "../lib/rule.js";

test("YES rule passes on matching features", () => {
  const result = evaluateYesRule({
    yesPrice: 0.7,
    features: {
      btcStart: 100,
      btcTriggerPrice: 101,
      aboveStartMinutes: 10,
      belowStartMinutes: 2,
      ret10mToTrigger: 0.001,
    },
  });
  assert.equal(result, true);
});

test("YES rule fails outside band", () => {
  const result = evaluateYesRule({
    yesPrice: 0.75,
    features: {
      btcStart: 100,
      btcTriggerPrice: 101,
      aboveStartMinutes: 10,
      belowStartMinutes: 2,
      ret10mToTrigger: 0.001,
    },
  });
  assert.equal(result, false);
});

test("NO rule passes on matching features", () => {
  const result = evaluateNoRule({
    noPrice: 0.68,
    features: {
      btcStart: 100,
      btcTriggerPrice: 99,
      aboveStartMinutes: 1,
      belowStartMinutes: 11,
      ret10mToTrigger: -0.001,
    },
  });
  assert.equal(result, true);
});

test("NO rule fails when trend filter fails", () => {
  const result = evaluateNoRule({
    noPrice: 0.68,
    features: {
      btcStart: 100,
      btcTriggerPrice: 101,
      aboveStartMinutes: 1,
      belowStartMinutes: 11,
      ret10mToTrigger: -0.001,
    },
  });
  assert.equal(result, false);
});
