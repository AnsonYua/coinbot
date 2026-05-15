import test from "node:test";
import assert from "node:assert/strict";

import { interpretOrderResult } from "../lib/check-bot-side.js";

test("interpretOrderResult rejects unsuccessful order without id", () => {
  const result = interpretOrderResult({
    success: false,
    status: "rejected",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.filled, false);
  assert.equal(result.orderId, null);
  assert.equal(result.orderStatus, "rejected");
});

test("interpretOrderResult accepts placed order with id but not filled", () => {
  const result = interpretOrderResult({
    orderID: "abc123",
    status: "live",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.filled, false);
  assert.equal(result.orderId, "abc123");
  assert.equal(result.orderStatus, "live");
});

test("interpretOrderResult marks matched order as filled", () => {
  const result = interpretOrderResult({
    success: true,
    orderID: "abc123",
    status: "matched",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.filled, true);
  assert.equal(result.orderId, "abc123");
  assert.equal(result.orderStatus, "matched");
});
