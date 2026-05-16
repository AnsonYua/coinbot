import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import { getConfig } from "./config.js";
import { ensureIndexes, insertRedeemRun } from "./mongo.js";
import { sendActionMessage, safeTelegram } from "./telegram.js";

const DATA_API_BASE = "https://data-api.polymarket.com";
const PUSD = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CTF_EXCHANGE = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const CTF_NEG_RISK_EXCHANGE = "0xc5d563a36ae78145c45a50134d48a1215220e4a0";
const NEG_RISK_ADAPTER = "0xc5d563a36ae78145c45a50134d48a1215220e4a0";
const ADAPTER = "0xd91e80f955ef0bd2a775bf1fb2617e1792d71b99";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

const ctfAbi = parseAbi([
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);

const adapterAbi = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);

function boolParam(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberParam(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePrivateKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}

function unique(values) {
  return [...new Set(values)];
}

export function groupRedeemablePositions(positions) {
  const grouped = new Map();
  for (const position of positions) {
    const conditionId = String(position.conditionId || "");
    if (!conditionId) continue;
    const group = grouped.get(conditionId) || {
      conditionId,
      marketSlug: position.market_slug || position.marketSlug || position.slug || null,
      title: position.title || position.question || null,
      negativeRisk: Boolean(position.negativeRisk || position.negRisk || false),
      outcomes: [],
      outcomeIndexes: [],
      totalSize: 0,
      rawPositions: [],
    };
    const outcomeIndex = Number(position.outcomeIndex);
    const size = Number(position.size || 0);
    if (Number.isFinite(size)) {
      group.totalSize += size;
    }
    if (Number.isFinite(outcomeIndex)) {
      group.outcomeIndexes.push(outcomeIndex + 1);
    }
    if (position.outcome != null) {
      group.outcomes.push(String(position.outcome));
    }
    group.rawPositions.push(position);
    grouped.set(conditionId, group);
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    outcomes: unique(group.outcomes),
    indexSets: unique(group.outcomeIndexes).sort((a, b) => a - b),
    totalSize: Math.round(group.totalSize * 1_000_000) / 1_000_000,
  }));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "btc-15m-wp-style-bot/1.0",
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

async function fetchRedeemablePositions({ userAddress, limit }) {
  const url = new URL(`${DATA_API_BASE}/positions`);
  url.searchParams.set("user", userAddress);
  url.searchParams.set("redeemable", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sizeThreshold", "0");
  const payload = await fetchJson(url.toString());
  return Array.isArray(payload) ? payload : [];
}

function createClients() {
  const config = getConfig();
  const privateKey = normalizePrivateKey(config.polymarketPrivateKey);
  if (!privateKey) {
    throw new Error("Missing POLYMARKET_PRIVATE_KEY");
  }
  const account = privateKeyToAccount(privateKey);
  const transport = http(config.polygonRpcUrl);
  return {
    accountAddress: account.address,
    publicClient: createPublicClient({ chain: polygon, transport }),
    walletClient: createWalletClient({ account, chain: polygon, transport }),
  };
}

export function validateRedeemSignerAddress({ signerAddress, userAddress, funderAddress }) {
  const normalizedSigner = String(signerAddress || "").toLowerCase();
  const candidates = [userAddress, funderAddress]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  if (candidates.length === 0) {
    return {
      ok: false,
      message: "Missing POLYMARKET_USER_ADDRESS or POLYMARKET_FUNDER_ADDRESS",
    };
  }
  if (candidates.includes(normalizedSigner)) {
    return { ok: true, message: null };
  }
  return {
    ok: false,
    message: `Redeem signer mismatch: POLYMARKET_PRIVATE_KEY resolves to ${signerAddress}, but redeemable positions are configured for ${userAddress || "(missing user address)"}${funderAddress ? ` / ${funderAddress}` : ""}. Use the private key for the wallet that owns the positions and fund it with POL for gas.`,
  };
}

function exchangeAddressForGroup(group) {
  return group.negativeRisk ? CTF_NEG_RISK_EXCHANGE : CTF_EXCHANGE;
}

function adapterAddressForGroup(group) {
  return group.negativeRisk ? NEG_RISK_ADAPTER : ADAPTER;
}

function exchangeAddressForOperator(operator) {
  return operator.toLowerCase() === NEG_RISK_ADAPTER.toLowerCase()
    ? CTF_NEG_RISK_EXCHANGE
    : CTF_EXCHANGE;
}

async function ensureApproval({ publicClient, walletClient, userAddress, operator, dryRun }) {
  const approved = await publicClient.readContract({
    address: exchangeAddressForOperator(operator),
    abi: ctfAbi,
    functionName: "isApprovedForAll",
    args: [userAddress, operator],
  });
  if (approved) {
    return { operator, approved: true, changed: false, txHash: null };
  }
  if (dryRun) {
    return { operator, approved: false, changed: false, txHash: null, wouldApprove: true };
  }
  const txHash = await walletClient.writeContract({
    address: exchangeAddressForOperator(operator),
    abi: ctfAbi,
    functionName: "setApprovalForAll",
    args: [operator, true],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { operator, approved: true, changed: true, txHash };
}

async function redeemGroup({ publicClient, walletClient, group, dryRun }) {
  const adapter = adapterAddressForGroup(group);
  if (!Array.isArray(group.indexSets) || group.indexSets.length === 0) {
    return {
      conditionId: group.conditionId,
      marketSlug: group.marketSlug,
      success: false,
      skipped: true,
      reason: "missing_index_sets",
    };
  }
  if (dryRun) {
    return {
      conditionId: group.conditionId,
      marketSlug: group.marketSlug,
      success: true,
      dryRun: true,
      title: group.title,
      adapter,
      indexSets: group.indexSets,
      totalSize: group.totalSize,
    };
  }
  const txHash = await walletClient.writeContract({
    address: adapter,
    abi: adapterAbi,
    functionName: "redeemPositions",
    args: [PUSD, ZERO_BYTES32, group.conditionId, group.indexSets.map((value) => BigInt(value))],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return {
    conditionId: group.conditionId,
    marketSlug: group.marketSlug,
    title: group.title,
    success: receipt.status === "success",
    txHash,
    receiptStatus: receipt.status,
    gasUsed: receipt.gasUsed ? formatUnits(receipt.gasUsed, 0) : null,
    adapter,
    indexSets: group.indexSets,
    totalSize: group.totalSize,
  };
}

function buildTelegramMessage({ userAddress, dryRun, positionsCount, groups, approvals, results }) {
  const successCount = results.filter((result) => result.success && !result.dryRun).length;
  const dryRunCount = results.filter((result) => result.dryRun).length;
  const skippedCount = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => result.success === false && !result.skipped);
  const lines = [
    "Polymarket redeem run",
    `user: ${userAddress}`,
    `redeemable positions: ${positionsCount}`,
    `conditions: ${groups.length}`,
    `approvals changed: ${approvals.filter((item) => item.changed).length}`,
    `dryRun: ${dryRun}`,
    `redeemed: ${successCount}`,
    `simulated: ${dryRunCount}`,
    `skipped: ${skippedCount}`,
    `failed: ${failed.length}`,
  ];
  for (const result of failed.slice(0, 5)) {
    lines.push(`fail ${result.marketSlug || result.conditionId}: ${result.error || result.reason || "unknown"}`);
  }
  return lines.join("\n");
}

export async function runRedeem({ dryRunOverride, maxConditionsOverride } = {}) {
  const config = getConfig();
  const dryRun = dryRunOverride == null
    ? config.dryRunDefault
    : boolParam(dryRunOverride, config.dryRunDefault);
  const maxConditions = numberParam(maxConditionsOverride, 20);
  const userAddress = config.polymarketUserAddress || config.polymarketFunderAddress;
  if (!userAddress) {
    throw new Error("Missing POLYMARKET_USER_ADDRESS");
  }

  await ensureIndexes();
  const positions = await fetchRedeemablePositions({ userAddress, limit: 500 });
  const groups = groupRedeemablePositions(positions).slice(0, maxConditions);

  const { accountAddress, publicClient, walletClient } = createClients();
  const signerCheck = validateRedeemSignerAddress({
    signerAddress: accountAddress,
    userAddress: config.polymarketUserAddress,
    funderAddress: config.polymarketFunderAddress,
  });
  if (!signerCheck.ok) {
    throw new Error(signerCheck.message);
  }
  const approvals = [];
  const approvalTargets = unique(groups.map((group) => adapterAddressForGroup(group).toLowerCase()));
  for (const operatorLower of approvalTargets) {
    const operator = operatorLower === NEG_RISK_ADAPTER.toLowerCase() ? NEG_RISK_ADAPTER : ADAPTER;
    approvals.push(await ensureApproval({
      publicClient,
      walletClient,
      userAddress,
      operator,
      dryRun,
    }));
  }

  const results = [];
  for (const group of groups) {
    try {
      results.push(await redeemGroup({ publicClient, walletClient, group, dryRun }));
    } catch (error) {
      results.push({
        conditionId: group.conditionId,
        marketSlug: group.marketSlug,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const message = buildTelegramMessage({
    userAddress,
    dryRun,
    positionsCount: positions.length,
    groups,
    approvals,
    results,
  });
  const telegram = await safeTelegram(() => sendActionMessage(config, message));

  const payload = {
    ok: true,
    dryRun,
    userAddress,
    positionsCount: positions.length,
    conditionsCount: groups.length,
    approvals,
    results,
    telegram,
    createdAt: new Date().toISOString(),
  };

  await insertRedeemRun({
    created_at: new Date(),
    dry_run: dryRun,
    user_address: userAddress,
    positions_count: positions.length,
    conditions_count: groups.length,
    approvals,
    results,
    telegram_sent: telegram.sent,
    telegram_error: telegram.error,
  });

  return payload;
}
