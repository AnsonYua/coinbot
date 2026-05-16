import test from "node:test";
import assert from "node:assert/strict";

import { groupRedeemablePositions, validateRedeemSignerAddress } from "../lib/redeem.js";

test("groupRedeemablePositions groups by condition and normalizes slug/index sets", () => {
  const grouped = groupRedeemablePositions([
    {
      conditionId: "0xabc",
      slug: "market-one",
      title: "Market One",
      outcome: "Yes",
      outcomeIndex: 0,
      size: 2.5,
      negativeRisk: false,
    },
    {
      conditionId: "0xabc",
      slug: "market-one",
      title: "Market One",
      outcome: "No",
      outcomeIndex: 1,
      size: 1.25,
      negativeRisk: false,
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].marketSlug, "market-one");
  assert.deepEqual(grouped[0].outcomes, ["Yes", "No"]);
  assert.deepEqual(grouped[0].indexSets, [1, 2]);
  assert.equal(grouped[0].totalSize, 3.75);
});

test("validateRedeemSignerAddress rejects signer mismatch", () => {
  const result = validateRedeemSignerAddress({
    signerAddress: "0x1111111111111111111111111111111111111111",
    userAddress: "0x2222222222222222222222222222222222222222",
    funderAddress: "0x3333333333333333333333333333333333333333",
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /Redeem signer mismatch/);
});
