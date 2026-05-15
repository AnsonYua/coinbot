import test from "node:test";
import assert from "node:assert/strict";

import { isAuthorized } from "../lib/config.js";

test("authorization accepts matching secret query", () => {
  process.env.CRON_SECRET = "topsecret";
  const req = { headers: {} };
  const query = new URLSearchParams({ secret: "topsecret" });
  assert.equal(isAuthorized(req, query), true);
});

test("authorization accepts bearer token", () => {
  process.env.CRON_SECRET = "topsecret";
  const req = { headers: { authorization: "Bearer topsecret" } };
  const query = new URLSearchParams();
  assert.equal(isAuthorized(req, query), true);
});

test("authorization rejects wrong secret", () => {
  process.env.CRON_SECRET = "topsecret";
  const req = { headers: {} };
  const query = new URLSearchParams({ secret: "wrong" });
  assert.equal(isAuthorized(req, query), false);
});
