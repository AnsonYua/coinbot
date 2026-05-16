import test from "node:test";
import assert from "node:assert/strict";

import { isExactTriggerMinute, isInTriggerWindow, resolveTriggerMarketStartTs, triggerTs } from "../lib/time.js";

test("trigger timestamp is 13 minutes after market start", () => {
  assert.equal(triggerTs(1_000), 1_780);
});

test("exact trigger minute matches the market trigger minute", () => {
  const marketStartTs = 1_800;
  const nowSeconds = marketStartTs + (13 * 60) + 5;
  assert.equal(isExactTriggerMinute(marketStartTs, nowSeconds), true);
});

test("exact trigger minute rejects other minutes", () => {
  const marketStartTs = 1_800;
  const nowSeconds = marketStartTs + (14 * 60);
  assert.equal(isExactTriggerMinute(marketStartTs, nowSeconds), false);
});

test("trigger window accepts short cron delay after trigger", () => {
  const marketStartTs = 1_800;
  const nowSeconds = marketStartTs + (14 * 60) + 30;
  assert.equal(isInTriggerWindow(marketStartTs, nowSeconds), true);
});

test("resolveTriggerMarketStartTs can recover previous market just after quarter rollover", () => {
  const previousMarketStartTs = 1_800;
  const nowSeconds = previousMarketStartTs + (15 * 60) + 5;
  assert.equal(resolveTriggerMarketStartTs(nowSeconds), previousMarketStartTs);
});

test("resolveTriggerMarketStartTs returns null outside allowed trigger windows", () => {
  const nowSeconds = 1_800 + (10 * 60);
  assert.equal(resolveTriggerMarketStartTs(nowSeconds), null);
});
