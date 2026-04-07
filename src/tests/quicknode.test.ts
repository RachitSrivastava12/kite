import { describe, test } from "node:test";
import assert from "node:assert";
import { createServer, type RequestListener } from "node:http";
import {
  // Priority Fee API
  getQuickNodePriorityFeesFactory,
  // Metaplex DAS API
  getAssetsByOwnerFactory,
  getAssetFactory,
  getAssetsByCollectionFactory,
  searchAssetsFactory,
  getAssetProofFactory,
  getWalletTokenAccountsFactory,
  // Multi-Chain Stablecoin Balance API
  getStablecoinBalancesFactory,
  // Metis — Jupiter V6 Swap API
  getJupiterSwapQuoteFactory,
  getJupiterSwapTransactionFactory,
  getPumpFunSwapTransactionFactory,
  // Lil' JIT — Jito Bundles
  sendJitoTransactionFactory,
  sendJitoBundleFactory,
  getBundleStatusesFactory,
  getInflightBundleStatusesFactory,
  getJitoTipAccountsFactory,
  getJitoTipFloorFactory,
  // MEV Protection (Merkle + Blink Labs)
  sendMerkleTransactionFactory,
  sendBlinkLabsTransactionFactory,
  // Iris Transaction Sender
  sendIrisTransactionFactory,
  // GoldRush — Multichain Data
  getGoldRushBalancesFactory,
  getGoldRushTransactionsFactory,
  // Titan DeFi Swap Meta-Aggregation
  getTitanSwapQuoteFactory,
  subscribeTitanQuotesFactory,
  // Risk Assessment API (Scorechain)
  assessWalletRiskFactory,
} from "../lib/quicknode";

// ─────────────────────────────────────────────────────────────
// Test infrastructure
// ─────────────────────────────────────────────────────────────

const QN_ENDPOINT = process.env.QN_ENDPOINT_URL ?? "";
const hasEndpoint  = QN_ENDPOINT.length > 0;

/**
 * Spin up a one-shot HTTP server, call fn(url), then shut it down.
 * Removes the try/finally boilerplate from every test.
 */
async function withServer(
  handler: RequestListener,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No server address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ── Mock server response helpers ─────────────────────────────

/** Successful JSON-RPC response: { result: ... } */
const rpcOk = (result: unknown): RequestListener => (_, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
};

/** JSON-RPC error in body (HTTP 200): { error: { code, message } } */
const rpcErr = (code: number, message: string): RequestListener => (_, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }));
};

/** HTTP-level error (4xx/5xx) */
const httpErr = (status: number): RequestListener => (_, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Error" }));
};

/** Successful REST JSON response */
const restOk = (data: unknown): RequestListener => (_, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

/** Log a skip reason for live tests */
const skip = (addon = "") => {
  const note = addon ? ` (${addon} add-on required)` : "";
  console.log(`Skipping live test — set QN_ENDPOINT_URL to run${note}`);
};

// ─────────────────────────────────────────────────────────────
// Shared mock fixtures
// ─────────────────────────────────────────────────────────────

const WALLET   = "E645TckHQnDcavVv92Etc6xSWQaq8zzPtPRGBheviRAk";
const MINT     = "JDv5J89tKZCbsZ1wRSynNdBQZU72wPsuj1uhDGf85pDn";
const COLL     = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w"; // Mad Lads collection
const SOL_M    = "So11111111111111111111111111111111111111112";
const USDC_M   = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MOCK_SIG = "5xSER5yV3S4ZbTVeGoFBrPrR7jJJDM8r9H2BPyFUeUVdNFPUNVHjzVPAbVUDe4FRGLnq9zF5rH3QcTGjBzGXDwP";

// Minimal DigitalAsset
const MOCK_ASSET = {
  id:        MINT,
  interface: "V1_NFT",
  content:   { json_uri: "https://arweave.net/1.json", metadata: { name: "Test NFT", symbol: "TNFT" } },
  ownership: { owner: WALLET, frozen: false, delegated: false },
  mutable:   true,
  burnt:     false,
};

const MOCK_ASSETS_PAGE = { total: 1, limit: 100, page: 1, items: [MOCK_ASSET] };

const MOCK_PROOF = {
  root: "rootHash", proof: ["p1", "p2"], node_index: 0, leaf: "leafHash", tree_id: "treeAddr",
};

const MOCK_TOKEN_ACCOUNTS = {
  value: [{
    pubkey: "TokenAcct11111111111111111111111111111111111",
    account: {
      data: {
        parsed: {
          info: {
            mint: USDC_M,
            tokenAmount: {
              amount: "100500000",
              decimals: 6,
              uiAmount: 100.5,
            },
          },
        },
      },
    },
  }],
};

// Pump Fun fixtures
const MOCK_PF_TOKEN = {
  mint: MINT, name: "Pepe", symbol: "PEPE", creator: WALLET,
  createdTimestamp: 1712000000, marketCapSol: 80, price: 0.00008,
  bondingCurve: {
    virtualTokenReserves: "1073000191", virtualSolReserves: "30000000000",
    realTokenReserves: "793100191", realSolReserves: "22148809",
    tokenTotalSupply: "1000000000000000", complete: false,
  },
  graduated: false,
};
const MOCK_PF_HOLDER = { address: WALLET, balance: "5000000", percentage: 15.5 };
const MOCK_PF_TRADE  = {
  signature: MOCK_SIG, mint: MINT, solAmount: "500000000", tokenAmount: "4000000",
  isBuy: true, user: WALLET, timestamp: 1712000100, slot: 250_000_000,
};

// Stablecoin fixture
const MOCK_STABLECOIN = {
  address: WALLET,
  timestamp: "2024-04-01T00:00:00Z",
  chains: {
    solana: {
      balances: [{
        token: "USDC",
        contract_address: USDC_M,
        decimals: 6,
        balance_raw: "100500000",
        balance_formatted: "100.5",
      }],
    },
  },
};

// Jupiter/Metis fixture
const MOCK_JUP_QUOTE = {
  inputMint: SOL_M, outputMint: USDC_M,
  inAmount: "1000000000", outAmount: "150000000",
  priceImpactPct: "0.01", slippageBps: 50, routePlan: [],
};

const MOCK_PUMP_FUN_SWAP = { tx: "BASE64PUMPFUNTX" };

// Titan fixture
const MOCK_TITAN_QUOTE = {
  inputMint: SOL_M, outputMint: USDC_M,
  inAmount: "1000000000", outAmount: "150000000", minOutAmount: "148500000",
  priceImpactPct: "0.01",
  routes: [{ dex: "Raydium", percent: 100, inAmount: "1000000000", outAmount: "150000000" }],
  timestamp: 1712000000,
};

// GoldRush fixtures
const MOCK_GR_BALANCES = {
  data: {
    chain_name: "solana-mainnet",
    address: WALLET,
    updated_at: "2024-04-01T00:00:00Z",
    items: [{
      contract_address: "native",
      contract_name: "Solana",
      contract_ticker_symbol: "SOL",
      contract_decimals: 9,
      balance: "1000000000",
    }],
  },
};
const MOCK_GR_TXS = {
  data: {
    current_page: 0,
    links: {},
    items: [{
      block_signed_at: "2024-04-01T00:00:00Z",
      tx_hash: MOCK_SIG,
      successful: true,
      from_address: WALLET,
      value: "1000000",
      fees_paid: "5000",
      gas_spent: "5000",
      gas_price: "1",
    }],
  },
};

// Scorechain fixture
const MOCK_RISK = {
  address: WALLET, network: "solana", riskScore: 5,
  riskLevel: "low", amlStatus: "clean", flags: [], assessedAt: "2024-04-01T00:00:00Z",
};

const MOCK_JITO_INFLIGHT = {
  value: [{ bundle_id: "bundle-1", status: "Pending", landed_slot: 250_000_001 }],
};

const MOCK_JITO_TIP_FLOOR = [{
  time: "2024-04-01T00:00:00Z",
  landed_tips_25th_percentile: 1000,
  landed_tips_50th_percentile: 2000,
  landed_tips_75th_percentile: 3000,
  landed_tips_95th_percentile: 4000,
  landed_tips_99th_percentile: 5000,
  ema_landed_tips_50th_percentile: 2500,
}];


// ════════════════════════════════════════════════════════════
// PRIORITY FEE API
// ════════════════════════════════════════════════════════════

describe("getQuickNodePriorityFeesFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getQuickNodePriorityFeesFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses all fee levels and networkCongestion from mock RPC response", async () => {
    const mockFees = {
      per_compute_unit: { extreme: 10000, high: 5000, medium: 2000, low: 1000, recommended: 3000 },
      recommended: 3500,
      network_congestion: 0.42,
    };
    await withServer(rpcOk(mockFees), async (url) => {
      const fees = await getQuickNodePriorityFeesFactory(url)();
      assert.equal(fees.low,               1000);
      assert.equal(fees.medium,            2000);
      assert.equal(fees.recommended,       3500);
      assert.equal(fees.high,              5000);
      assert.equal(fees.extreme,           10000);
      assert.equal(fees.networkCongestion, 0.42);
    });
  });

  test("defaults networkCongestion to 0 when absent from response", async () => {
    const mockFees = {
      per_compute_unit: { extreme: 1, high: 1, medium: 1, low: 1, recommended: 1 },
    };
    await withServer(rpcOk(mockFees), async (url) => {
      const fees = await getQuickNodePriorityFeesFactory(url)();
      assert.equal(fees.networkCongestion, 0);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => getQuickNodePriorityFeesFactory(url)(),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  test("throws on RPC method error in body", async () => {
    await withServer(rpcErr(-32601, "Method not found"), async (url) => {
      await assert.rejects(
        () => getQuickNodePriorityFeesFactory(url)(),
        (e: Error) => {
          assert.ok(e.message.includes("-32601") || e.message.includes("Method not found"));
          return true;
        },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns all fee levels from live endpoint", async () => {
    if (!hasEndpoint) { skip("Solana Priority Fee API"); return; }
    const fees = await getQuickNodePriorityFeesFactory(QN_ENDPOINT)();
    assert.ok(typeof fees === "object" && fees !== null);
    for (const key of ["low", "medium", "recommended", "high", "extreme"] as const) {
      assert.ok(typeof fees[key] === "number" && fees[key] >= 0, `${key} must be >= 0`);
    }
    assert.ok(typeof fees.networkCongestion === "number", "networkCongestion must be a number");
  });

  test("accepts account and lastNBlocks options (live)", async () => {
    if (!hasEndpoint) { skip(); return; }
    const fees = await getQuickNodePriorityFeesFactory(QN_ENDPOINT)({
      account:     "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      lastNBlocks: 50,
    });
    assert.ok(typeof fees.low  === "number");
    assert.ok(typeof fees.high === "number");
  });
});


// ════════════════════════════════════════════════════════════
// DAS — getAssetsByOwnerFactory
// ════════════════════════════════════════════════════════════

describe("getAssetsByOwnerFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getAssetsByOwnerFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses assets page from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_ASSETS_PAGE), async (url) => {
      const result = await getAssetsByOwnerFactory(url)({ ownerAddress: WALLET });
      assert.equal(result.total, 1);
      assert.equal(result.page,  1);
      assert.ok(Array.isArray(result.items));
      assert.equal(result.items[0]?.id, MINT);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(500), async (url) => {
      await assert.rejects(
        () => getAssetsByOwnerFactory(url)({ ownerAddress: WALLET }),
        (e: Error) => { assert.ok(e.message.includes("500")); return true; },
      );
    });
  });

  test("throws on RPC error in body", async () => {
    await withServer(rpcErr(-32602, "Invalid params"), async (url) => {
      await assert.rejects(
        () => getAssetsByOwnerFactory(url)({ ownerAddress: "bad" }),
        (e: Error) => {
          assert.ok(e.message.includes("-32602") || e.message.includes("Invalid params"));
          return true;
        },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns assets page shape (live)", async () => {
    if (!hasEndpoint) { skip("Metaplex DAS"); return; }
    const result = await getAssetsByOwnerFactory(QN_ENDPOINT)({ ownerAddress: WALLET, limit: 5 });
    assert.ok(typeof result.total === "number" && result.total >= 0);
    assert.ok(typeof result.limit === "number");
    assert.ok(typeof result.page  === "number" && result.page >= 1);
    assert.ok(Array.isArray(result.items));
    for (const asset of result.items) {
      assert.ok(typeof asset.id        === "string",  "asset.id must be a string");
      assert.ok(typeof asset.interface === "string",  "asset.interface must be a string");
      assert.ok(typeof asset.mutable   === "boolean", "asset.mutable must be a boolean");
      assert.ok(typeof asset.burnt     === "boolean", "asset.burnt must be a boolean");
    }
  });

  test("respects limit option (live)", async () => {
    if (!hasEndpoint) { skip(); return; }
    const result = await getAssetsByOwnerFactory(QN_ENDPOINT)({ ownerAddress: WALLET, limit: 1 });
    assert.ok(result.items.length <= 1, "items.length must be <= limit");
  });

  test("returns correct shape for a wallet with no assets (live)", async () => {
    if (!hasEndpoint) { skip(); return; }
    const result = await getAssetsByOwnerFactory(QN_ENDPOINT)({
      ownerAddress: "Vote111111111111111111111111111111111111111",
      limit: 1,
    });
    assert.ok(typeof result.total === "number" && result.total >= 0);
    assert.ok(Array.isArray(result.items));
  });
});


// ════════════════════════════════════════════════════════════
// DAS — getAssetFactory
// ════════════════════════════════════════════════════════════

describe("getAssetFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getAssetFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses asset from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_ASSET), async (url) => {
      const asset = await getAssetFactory(url)(MINT);
      assert.equal(asset.id,        MINT);
      assert.equal(asset.interface, "V1_NFT");
      assert.equal(asset.mutable,   true);
      assert.equal(asset.burnt,     false);
      assert.equal(asset.ownership.owner, WALLET);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => getAssetFactory(url)(MINT),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  test("throws on RPC error in body", async () => {
    await withServer(rpcErr(-32602, "Invalid params"), async (url) => {
      await assert.rejects(
        () => getAssetFactory(url)("badMint"),
        (e: Error) => {
          assert.ok(e.message.includes("-32602") || e.message.includes("Invalid params"));
          return true;
        },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns full asset details for a known mint (live)", async () => {
    if (!hasEndpoint) { skip("Metaplex DAS"); return; }
    const asset = await getAssetFactory(QN_ENDPOINT)(MINT);
    assert.ok(typeof asset.id        === "string");
    assert.ok(typeof asset.interface === "string");
    assert.ok(typeof asset.mutable   === "boolean");
    assert.ok(typeof asset.burnt     === "boolean");
    assert.ok(asset.content?.metadata?.name !== undefined, "must have metadata.name");
    assert.ok(typeof asset.ownership?.owner === "string",  "must have ownership.owner");
  });

  test("has compression fields when asset is compressed (live)", async () => {
    if (!hasEndpoint) { skip(); return; }
    const asset = await getAssetFactory(QN_ENDPOINT)(MINT);
    if (asset.compression?.compressed) {
      assert.ok(typeof asset.compression.tree    === "string");
      assert.ok(typeof asset.compression.leaf_id === "number");
      assert.ok(typeof asset.compression.seq     === "number");
    }
  });
});


// ════════════════════════════════════════════════════════════
// DAS — getAssetsByCollectionFactory
// ════════════════════════════════════════════════════════════

describe("getAssetsByCollectionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getAssetsByCollectionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses assets page from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_ASSETS_PAGE), async (url) => {
      const result = await getAssetsByCollectionFactory(url)({ collectionMint: COLL, limit: 5 });
      assert.equal(result.total, 1);
      assert.ok(Array.isArray(result.items));
      assert.equal(result.items[0]?.id, MINT);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(500), async (url) => {
      await assert.rejects(
        () => getAssetsByCollectionFactory(url)({ collectionMint: COLL }),
        (e: Error) => { assert.ok(e.message.includes("500")); return true; },
      );
    });
  });

  test("throws on RPC error in body", async () => {
    await withServer(rpcErr(-32602, "Invalid params"), async (url) => {
      await assert.rejects(
        () => getAssetsByCollectionFactory(url)({ collectionMint: "bad" }),
        (e: Error) => {
          assert.ok(e.message.includes("-32602") || e.message.includes("Invalid params"));
          return true;
        },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns assets for a known collection (live)", async () => {
    if (!hasEndpoint) { skip("Metaplex DAS"); return; }
    const result = await getAssetsByCollectionFactory(QN_ENDPOINT)({ collectionMint: COLL, limit: 3 });
    assert.ok(typeof result.total === "number" && result.total >= 0);
    assert.ok(Array.isArray(result.items));
  });
});


// ════════════════════════════════════════════════════════════
// DAS — searchAssetsFactory
// ════════════════════════════════════════════════════════════

describe("searchAssetsFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof searchAssetsFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses assets page from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_ASSETS_PAGE), async (url) => {
      const result = await searchAssetsFactory(url)({ ownerAddress: WALLET });
      assert.equal(result.total, 1);
      assert.ok(Array.isArray(result.items));
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(500), async (url) => {
      await assert.rejects(
        () => searchAssetsFactory(url)({ ownerAddress: WALLET }),
        (e: Error) => { assert.ok(e.message.includes("500")); return true; },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns matching assets for owner (live)", async () => {
    if (!hasEndpoint) { skip("Metaplex DAS"); return; }
    const result = await searchAssetsFactory(QN_ENDPOINT)({ ownerAddress: WALLET, limit: 5 });
    assert.ok(typeof result.total === "number" && result.total >= 0);
    assert.ok(Array.isArray(result.items));
  });

  test("filters by compressed=true and verifies all returned items are compressed (live)", async () => {
    if (!hasEndpoint) { skip("Metaplex DAS"); return; }
    const result = await searchAssetsFactory(QN_ENDPOINT)({ ownerAddress: WALLET, compressed: true, limit: 5 });
    assert.ok(Array.isArray(result.items));
    for (const asset of result.items) {
      assert.ok(asset.compression?.compressed === true, "all items should be compressed");
    }
  });
});


// ════════════════════════════════════════════════════════════
// DAS — getAssetProofFactory
// ════════════════════════════════════════════════════════════

describe("getAssetProofFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getAssetProofFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses proof from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_PROOF), async (url) => {
      const proof = await getAssetProofFactory(url)(MINT);
      assert.equal(proof.root,       "rootHash");
      assert.equal(proof.node_index, 0);
      assert.equal(proof.leaf,       "leafHash");
      assert.equal(proof.tree_id,    "treeAddr");
      assert.ok(Array.isArray(proof.proof));
      assert.equal(proof.proof.length, 2);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(404), async (url) => {
      await assert.rejects(
        () => getAssetProofFactory(url)(MINT),
        (e: Error) => { assert.ok(e.message.includes("404")); return true; },
      );
    });
  });

  test("throws on RPC error (e.g. not a compressed NFT)", async () => {
    await withServer(rpcErr(-32600, "Asset is not compressed"), async (url) => {
      await assert.rejects(
        () => getAssetProofFactory(url)(MINT),
        (e: Error) => {
          assert.ok(e.message.includes("-32600") || e.message.includes("compressed"));
          return true;
        },
      );
    });
  });
});


// ════════════════════════════════════════════════════════════
// DAS — getWalletTokenAccountsFactory
// ════════════════════════════════════════════════════════════

describe("getWalletTokenAccountsFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getWalletTokenAccountsFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses token accounts from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_TOKEN_ACCOUNTS), async (url) => {
      const accounts = await getWalletTokenAccountsFactory(url)({ ownerAddress: WALLET });
      assert.ok(Array.isArray(accounts));
      assert.equal(accounts[0]?.mint, USDC_M);
      assert.equal(accounts[0]?.balance, 100500000);
      assert.equal(accounts[0]?.decimals, 6);
      assert.equal(accounts[0]?.uiAmount, 100.5);
    });
  });
});

// ════════════════════════════════════════════════════════════
// MULTI-CHAIN STABLECOIN BALANCE API
// ════════════════════════════════════════════════════════════

describe("getStablecoinBalancesFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getStablecoinBalancesFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses stablecoin balance result from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_STABLECOIN), async (url) => {
      const result = await getStablecoinBalancesFactory(url)({ walletAddress: WALLET });
      assert.equal(result.walletAddress, WALLET);
      assert.equal(result.totalUsdValue, undefined);
      assert.ok(Array.isArray(result.balances));
      assert.equal(result.balances[0]?.symbol,  "USDC");
      assert.equal(result.balances[0]?.chain,   "solana");
      assert.equal(result.balances[0]?.balance, "100500000");
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(500), async (url) => {
      await assert.rejects(
        () => getStablecoinBalancesFactory(url)({ walletAddress: WALLET }),
        (e: Error) => { assert.ok(e.message.includes("500")); return true; },
      );
    });
  });

  test("throws on RPC method error (add-on not enabled)", async () => {
    await withServer(rpcErr(-32601, "Method not found"), async (url) => {
      await assert.rejects(
        () => getStablecoinBalancesFactory(url)({ walletAddress: WALLET }),
        (e: Error) => {
          assert.ok(e.message.includes("-32601") || e.message.includes("Method not found"));
          return true;
        },
      );
    });
  });

  test("uses the documented RPC method and address param", async () => {
    let capturedBody = "";
    await withServer(
      (req, res) => {
        req.on("data", (chunk: Buffer) => { capturedBody += chunk.toString(); });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: MOCK_STABLECOIN }));
        });
      },
      async (url) => {
        await getStablecoinBalancesFactory(url)({ walletAddress: WALLET, chains: ["solana"] });
        const body = JSON.parse(capturedBody) as { method: string; params: { address: string; chains: string[] } };
        assert.equal(body.method, "getStablecoinBalances");
        assert.equal(body.params.address, WALLET);
        assert.deepEqual(body.params.chains, ["solana"]);
      },
    );
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns stablecoin balance shape from live endpoint", async () => {
    if (!hasEndpoint) { skip("Multi-Chain Stablecoin Balance API"); return; }
    const result = await getStablecoinBalancesFactory(QN_ENDPOINT)({ walletAddress: WALLET });
    assert.ok(typeof result.walletAddress === "string");
    assert.ok(result.totalUsdValue === undefined || typeof result.totalUsdValue === "number");
    assert.ok(Array.isArray(result.balances));
  });
});


// ════════════════════════════════════════════════════════════
// METIS — JUPITER V6 SWAP — getJupiterSwapQuoteFactory
// ════════════════════════════════════════════════════════════

describe("getJupiterSwapQuoteFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getJupiterSwapQuoteFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses swap quote from mock REST response", async () => {
    await withServer(restOk(MOCK_JUP_QUOTE), async (url) => {
      const quote = await getJupiterSwapQuoteFactory(url)({
        inputMint: SOL_M, outputMint: USDC_M, amount: 1_000_000_000n,
      });
      assert.equal(quote.inputMint,      SOL_M);
      assert.equal(quote.outputMint,     USDC_M);
      assert.equal(quote.inAmount,       "1000000000");
      assert.equal(quote.outAmount,      "150000000");
      assert.equal(quote.slippageBps,    50);
      assert.equal(typeof quote.priceImpactPct, "string");
      assert.ok(Array.isArray(quote.routePlan));
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(400), async (url) => {
      await assert.rejects(
        () => getJupiterSwapQuoteFactory(url)({ inputMint: SOL_M, outputMint: USDC_M, amount: 1n }),
        (e: Error) => { assert.ok(e.message.includes("400")); return true; },
      );
    });
  });

  test("uses the current Metis /quote path", async () => {
    let capturedUrl = "";
    await withServer(
      (req, res) => {
        capturedUrl = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_JUP_QUOTE));
      },
      async (url) => {
        await getJupiterSwapQuoteFactory(url)({
          inputMint: SOL_M, outputMint: USDC_M, amount: 1_000_000n,
        });
        assert.ok(capturedUrl.startsWith("/quote?"), `Expected /quote path, got ${capturedUrl}`);
      },
    );
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns a valid SOL→USDC quote from live endpoint", async () => {
    if (!hasEndpoint) { skip("Metis — Jupiter V6 Swap API"); return; }
    const quote = await getJupiterSwapQuoteFactory(QN_ENDPOINT)({
      inputMint: SOL_M, outputMint: USDC_M, amount: 10_000_000n, // 0.01 SOL
    });
    assert.ok(typeof quote.inAmount    === "string");
    assert.ok(typeof quote.outAmount   === "string");
    assert.ok(typeof quote.slippageBps === "number");
    assert.ok(Array.isArray(quote.routePlan));
    assert.ok(BigInt(quote.outAmount) > 0n, "should receive some USDC");
  });
});


// ════════════════════════════════════════════════════════════
// METIS — JUPITER V6 SWAP — getJupiterSwapTransactionFactory
// ════════════════════════════════════════════════════════════

describe("getJupiterSwapTransactionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getJupiterSwapTransactionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("returns base64 swapTransaction from mock REST POST response", async () => {
    await withServer(restOk({ swapTransaction: "BASE64ENCODEDTRANSACTIONDATA" }), async (url) => {
      const result = await getJupiterSwapTransactionFactory(url)({
        quoteResponse: MOCK_JUP_QUOTE as any,
        userPublicKey: WALLET,
      });
      assert.equal(typeof result.swapTransaction, "string");
      assert.ok(result.swapTransaction.length > 0);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(400), async (url) => {
      await assert.rejects(
        () => getJupiterSwapTransactionFactory(url)({ quoteResponse: MOCK_JUP_QUOTE as any, userPublicKey: WALLET }),
        (e: Error) => { assert.ok(e.message.includes("400")); return true; },
      );
    });
  });

  test("uses the current Metis /swap path", async () => {
    let capturedUrl = "";
    await withServer(
      (req, res) => {
        capturedUrl = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ swapTransaction: "BASE64ENCODEDTRANSACTIONDATA" }));
      },
      async (url) => {
        await getJupiterSwapTransactionFactory(url)({
          quoteResponse: MOCK_JUP_QUOTE as any,
          userPublicKey: WALLET,
        });
        assert.equal(capturedUrl, "/swap");
      },
    );
  });
});


// ════════════════════════════════════════════════════════════
// METIS — PUMP.FUN SWAP — getPumpFunSwapTransactionFactory
// ════════════════════════════════════════════════════════════

describe("getPumpFunSwapTransactionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getPumpFunSwapTransactionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("returns tx from mock REST response", async () => {
    await withServer(restOk(MOCK_PUMP_FUN_SWAP), async (url) => {
      const result = await getPumpFunSwapTransactionFactory(url)({
        wallet: WALLET,
        type: "BUY",
        mint: MINT,
        inAmount: "1000000",
      });
      assert.equal(result.tx, "BASE64PUMPFUNTX");
    });
  });

  test("uses the documented pump-fun swap path", async () => {
    let capturedUrl = "";
    await withServer(
      (req, res) => {
        capturedUrl = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_PUMP_FUN_SWAP));
      },
      async (url) => {
        await getPumpFunSwapTransactionFactory(url)({
          wallet: WALLET,
          type: "BUY",
          mint: MINT,
          inAmount: "1000000",
        });
        assert.equal(capturedUrl, "/pump-fun/swap");
      },
    );
  });
});


// ════════════════════════════════════════════════════════════
// LIL' JIT — sendJitoBundleFactory
// ════════════════════════════════════════════════════════════

describe("sendJitoBundleFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof sendJitoBundleFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("returns bundle UUID from mock RPC response", async () => {
    const bundleId = "abc123-bundle-uuid";
    await withServer(rpcOk(bundleId), async (url) => {
      const result = await sendJitoBundleFactory(url)(["base64tx1", "base64tx2"]);
      assert.equal(result, bundleId);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => sendJitoBundleFactory(url)(["tx1"]),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  test("throws on RPC error (add-on not enabled)", async () => {
    await withServer(rpcErr(-32601, "Method not found"), async (url) => {
      await assert.rejects(
        () => sendJitoBundleFactory(url)(["tx1"]),
        (e: Error) => {
          assert.ok(e.message.includes("-32601") || e.message.includes("Method not found"));
          return true;
        },
      );
    });
  });
});


// ════════════════════════════════════════════════════════════
// LIL' JIT — sendJitoTransactionFactory
// ════════════════════════════════════════════════════════════

describe("sendJitoTransactionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof sendJitoTransactionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("returns transaction signature from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_SIG), async (url) => {
      const sig = await sendJitoTransactionFactory(url)("base64tx");
      assert.equal(sig, MOCK_SIG);
    });
  });

  test("supports bundleOnly query flag", async () => {
    let capturedUrl = "";
    await withServer(
      (req, res) => {
        capturedUrl = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: MOCK_SIG }));
      },
      async (url) => {
        await sendJitoTransactionFactory(url)("base64tx", { bundleOnly: true });
        assert.ok(capturedUrl.includes("bundleOnly=true"), `Expected bundleOnly=true in ${capturedUrl}`);
      },
    );
  });
});


// ════════════════════════════════════════════════════════════
// LIL' JIT — getBundleStatusesFactory
// ════════════════════════════════════════════════════════════

describe("getBundleStatusesFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getBundleStatusesFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses and maps bundle statuses from mock RPC response", async () => {
    const mockResult = {
      value: [
        { bundle_id: "uuid-1", confirmation_status: "Landed",  slot: 100 },
        { bundle_id: "uuid-2", confirmation_status: "Pending" },
      ],
    };
    await withServer(rpcOk(mockResult), async (url) => {
      const statuses = await getBundleStatusesFactory(url)(["uuid-1", "uuid-2"]);
      assert.equal(statuses.length, 2);
      assert.equal(statuses[0]?.bundleId,   "uuid-1");
      assert.equal(statuses[0]?.status,     "Landed");
      assert.equal(statuses[0]?.landedSlot, 100);
      assert.equal(statuses[1]?.bundleId,   "uuid-2");
      assert.equal(statuses[1]?.status,     "Pending");
      assert.equal(statuses[1]?.landedSlot, undefined);
    });
  });

  test("returns empty array when value is empty", async () => {
    await withServer(rpcOk({ value: [] }), async (url) => {
      const statuses = await getBundleStatusesFactory(url)(["uuid-1"]);
      assert.deepEqual(statuses, []);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => getBundleStatusesFactory(url)(["uuid"]),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });
});


// ════════════════════════════════════════════════════════════
// LIL' JIT — getInflightBundleStatusesFactory
// ════════════════════════════════════════════════════════════

describe("getInflightBundleStatusesFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getInflightBundleStatusesFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses inflight bundle statuses from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_JITO_INFLIGHT), async (url) => {
      const result = await getInflightBundleStatusesFactory(url)(["bundle-1"], { region: "ny" });
      assert.equal(result[0]?.bundleId, "bundle-1");
      assert.equal(result[0]?.status, "Pending");
      assert.equal(result[0]?.landedSlot, 250_000_001);
    });
  });
});


// ════════════════════════════════════════════════════════════
// LIL' JIT — getJitoTipAccountsFactory
// ════════════════════════════════════════════════════════════

describe("getJitoTipAccountsFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getJitoTipAccountsFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("returns tip accounts from mock RPC response", async () => {
    await withServer(rpcOk(["tip-account-1"]), async (url) => {
      const result = await getJitoTipAccountsFactory(url)({ region: "ny" });
      assert.deepEqual(result, ["tip-account-1"]);
    });
  });
});


// ════════════════════════════════════════════════════════════
// LIL' JIT — getJitoTipFloorFactory
// ════════════════════════════════════════════════════════════

describe("getJitoTipFloorFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getJitoTipFloorFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("maps tip floor percentiles from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_JITO_TIP_FLOOR), async (url) => {
      const result = await getJitoTipFloorFactory(url)();
      assert.equal(result[0]?.landedTips50thPercentile, 2000);
      assert.equal(result[0]?.emaLandedTips50thPercentile, 2500);
    });
  });
});


// ════════════════════════════════════════════════════════════
// MEV PROTECTION — sendMerkleTransactionFactory
// ════════════════════════════════════════════════════════════

describe("sendMerkleTransactionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof sendMerkleTransactionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("returns transaction signature from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_SIG), async (url) => {
      const sig = await sendMerkleTransactionFactory(url)({ serializedTransaction: "base64tx" });
      assert.equal(sig, MOCK_SIG);
    });
  });

  test("uses sendTransaction with base64 encoding", async () => {
    let capturedBody = "";
    await withServer(
      (req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          capturedBody = body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: MOCK_SIG }));
        });
      },
      async (url) => {
        await sendMerkleTransactionFactory(url)({ serializedTransaction: "base64tx" });
        const body = JSON.parse(capturedBody) as { method: string; params: [string, { encoding: string }] };
        assert.equal(body.method, "sendTransaction");
        assert.equal(body.params[0], "base64tx");
        assert.equal(body.params[1]?.encoding, "base64");
      },
    );
  });

  test("rejects tipLamports because tips must be embedded in the signed transaction", async () => {
    await assert.rejects(
      () => sendMerkleTransactionFactory("https://example.quiknode.pro/token/")({
        serializedTransaction: "base64tx",
        tipLamports: 10_000,
      }),
      (e: Error) => {
        assert.ok(e.message.includes("signed transaction"));
        return true;
      },
    );
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => sendMerkleTransactionFactory(url)({ serializedTransaction: "base64tx" }),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  test("throws on RPC method error (add-on not enabled)", async () => {
    await withServer(rpcErr(-32601, "Method not found"), async (url) => {
      await assert.rejects(
        () => sendMerkleTransactionFactory(url)({ serializedTransaction: "base64tx" }),
        (e: Error) => {
          assert.ok(e.message.includes("-32601") || e.message.includes("Method not found"));
          return true;
        },
      );
    });
  });
});


// ════════════════════════════════════════════════════════════
// MEV RESILIENCE — sendBlinkLabsTransactionFactory
// ════════════════════════════════════════════════════════════

describe("sendBlinkLabsTransactionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof sendBlinkLabsTransactionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("returns transaction signature from mock RPC response", async () => {
    await withServer(rpcOk(MOCK_SIG), async (url) => {
      const sig = await sendBlinkLabsTransactionFactory(url)({ serializedTransaction: "base64tx" });
      assert.equal(sig, MOCK_SIG);
    });
  });

  test("uses sendTransaction with base64 encoding", async () => {
    let capturedBody = "";
    await withServer(
      (req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          capturedBody = body;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: MOCK_SIG }));
        });
      },
      async (url) => {
        await sendBlinkLabsTransactionFactory(url)({ serializedTransaction: "base64tx" });
        const body = JSON.parse(capturedBody) as { method: string; params: [string, { encoding: string }] };
        assert.equal(body.method, "sendTransaction");
        assert.equal(body.params[0], "base64tx");
        assert.equal(body.params[1]?.encoding, "base64");
      },
    );
  });

  test("rejects tipLamports because tips must be embedded in the signed transaction", async () => {
    await assert.rejects(
      () => sendBlinkLabsTransactionFactory("https://example.quiknode.pro/token/")({
        serializedTransaction: "base64tx",
        tipLamports: 5_000,
      }),
      (e: Error) => {
        assert.ok(e.message.includes("signed transaction"));
        return true;
      },
    );
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => sendBlinkLabsTransactionFactory(url)({ serializedTransaction: "base64tx" }),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  test("throws on RPC method error (add-on not enabled)", async () => {
    await withServer(rpcErr(-32601, "Method not found"), async (url) => {
      await assert.rejects(
        () => sendBlinkLabsTransactionFactory(url)({ serializedTransaction: "base64tx" }),
        (e: Error) => {
          assert.ok(e.message.includes("-32601") || e.message.includes("Method not found"));
          return true;
        },
      );
    });
  });
});


// ════════════════════════════════════════════════════════════
// IRIS TRANSACTION SENDER — sendIrisTransactionFactory
// ════════════════════════════════════════════════════════════

describe("sendIrisTransactionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof sendIrisTransactionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses IrisTxResult (signature + slot) from mock RPC response", async () => {
    await withServer(rpcOk({ signature: MOCK_SIG, slot: 250_000_000 }), async (url) => {
      const result = await sendIrisTransactionFactory(url)({ serializedTransaction: "base64tx" });
      assert.equal(result.signature, MOCK_SIG);
      assert.equal(result.slot,      250_000_000);
    });
  });

  test("works when slot is absent in response", async () => {
    await withServer(rpcOk({ signature: MOCK_SIG }), async (url) => {
      const result = await sendIrisTransactionFactory(url)({ serializedTransaction: "base64tx" });
      assert.equal(result.signature, MOCK_SIG);
      assert.equal(result.slot,      undefined);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => sendIrisTransactionFactory(url)({ serializedTransaction: "base64tx" }),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  test("throws on RPC method error (add-on not enabled)", async () => {
    await withServer(rpcErr(-32601, "Method not found"), async (url) => {
      await assert.rejects(
        () => sendIrisTransactionFactory(url)({ serializedTransaction: "base64tx" }),
        (e: Error) => {
          assert.ok(e.message.includes("-32601") || e.message.includes("Method not found"));
          return true;
        },
      );
    });
  });
});


// ════════════════════════════════════════════════════════════
// GOLDRUSH — getGoldRushBalancesFactory
// ════════════════════════════════════════════════════════════

describe("getGoldRushBalancesFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getGoldRushBalancesFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses balances from mock REST response", async () => {
    await withServer(restOk(MOCK_GR_BALANCES), async (url) => {
      const result = await getGoldRushBalancesFactory(url)({ walletAddress: WALLET });
      assert.equal(result.chain,        "solana-mainnet");
      assert.equal(result.address,      WALLET);
      assert.ok(Array.isArray(result.items));
      assert.equal(result.items[0]?.symbol, "SOL");
    });
  });

  test("defaults to solana-mainnet chain", async () => {
    let capturedUrl = "";
    await withServer(
      (req, res) => {
        capturedUrl = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_GR_BALANCES));
      },
      async (url) => {
        await getGoldRushBalancesFactory(url)({ walletAddress: WALLET });
        assert.ok(
          capturedUrl.includes("solana-mainnet"),
          `Expected solana-mainnet in path: ${capturedUrl}`,
        );
      },
    );
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => getGoldRushBalancesFactory(url)({ walletAddress: WALLET }),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns balances shape from live endpoint", async () => {
    if (!hasEndpoint) { skip("GoldRush — Multichain Data APIs"); return; }
    const result = await getGoldRushBalancesFactory(QN_ENDPOINT)({ walletAddress: WALLET });
    assert.ok(typeof result.chain   === "string");
    assert.ok(typeof result.address === "string");
    assert.ok(Array.isArray(result.items));
  });
});


// ════════════════════════════════════════════════════════════
// GOLDRUSH — getGoldRushTransactionsFactory
// ════════════════════════════════════════════════════════════

describe("getGoldRushTransactionsFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getGoldRushTransactionsFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses transaction list from mock REST response", async () => {
    await withServer(restOk(MOCK_GR_TXS), async (url) => {
      const result = await getGoldRushTransactionsFactory(url)({ walletAddress: WALLET });
      assert.ok(Array.isArray(result.items));
      assert.equal(result.items[0]?.txHash,     MOCK_SIG);
      assert.equal(result.items[0]?.successful, true);
      assert.equal(result.currentPage,          0);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => getGoldRushTransactionsFactory(url)({ walletAddress: WALLET }),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns transaction list shape from live endpoint", async () => {
    if (!hasEndpoint) { skip("GoldRush — Multichain Data APIs"); return; }
    const result = await getGoldRushTransactionsFactory(QN_ENDPOINT)({ walletAddress: WALLET, pageSize: 5 });
    assert.ok(Array.isArray(result.items));
    assert.ok(typeof result.currentPage === "number");
  });
});


// ════════════════════════════════════════════════════════════
// TITAN — getTitanSwapQuoteFactory
// ════════════════════════════════════════════════════════════

describe("getTitanSwapQuoteFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getTitanSwapQuoteFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses swap quote including routes from mock REST response", async () => {
    await withServer(restOk(MOCK_TITAN_QUOTE), async (url) => {
      const quote = await getTitanSwapQuoteFactory(url)({
        inputMint: SOL_M, outputMint: USDC_M, amount: "1000000000",
      });
      assert.equal(quote.inputMint,       SOL_M);
      assert.equal(quote.outputMint,      USDC_M);
      assert.equal(quote.inAmount,        "1000000000");
      assert.equal(quote.outAmount,       "150000000");
      assert.equal(typeof quote.priceImpactPct, "string");
      assert.ok(Array.isArray(quote.routes));
      assert.equal(quote.routes[0]?.dex,     "Raydium");
      assert.equal(quote.routes[0]?.percent, 100);
    });
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(503), async (url) => {
      await assert.rejects(
        () => getTitanSwapQuoteFactory(url)({ inputMint: SOL_M, outputMint: USDC_M, amount: "1" }),
        (e: Error) => { assert.ok(e.message.includes("503")); return true; },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns a valid quote from live endpoint", async () => {
    if (!hasEndpoint) { skip("DeFi Swap Meta-Aggregation API (Titan)"); return; }
    const quote = await getTitanSwapQuoteFactory(QN_ENDPOINT)({
      inputMint: SOL_M, outputMint: USDC_M, amount: "10000000",
    });
    assert.ok(typeof quote.inAmount  === "string");
    assert.ok(typeof quote.outAmount === "string");
    assert.ok(Array.isArray(quote.routes));
  });
});


// ════════════════════════════════════════════════════════════
// TITAN — subscribeTitanQuotesFactory
// ════════════════════════════════════════════════════════════

describe("subscribeTitanQuotesFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof subscribeTitanQuotesFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("the subscribe function itself is a function (WebSocket not opened until called)", () => {
    // The factory returns a subscribe fn. We verify the type without opening a real WS.
    const subscribe = subscribeTitanQuotesFactory("wss://example.quiknode.pro/token/");
    assert.equal(typeof subscribe, "function");
  });
});


// ════════════════════════════════════════════════════════════
// RISK ASSESSMENT — assessWalletRiskFactory
// ════════════════════════════════════════════════════════════

describe("assessWalletRiskFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof assessWalletRiskFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses risk assessment from mock REST response", async () => {
    await withServer(restOk(MOCK_RISK), async (url) => {
      const result = await assessWalletRiskFactory(url)({ address: WALLET });
      assert.equal(result.address,   WALLET);
      assert.equal(result.network,   "solana");
      assert.equal(result.riskScore, 5);
      assert.equal(result.riskLevel, "low");
      assert.equal(result.amlStatus, "clean");
      assert.ok(Array.isArray(result.flags));
      assert.equal(typeof result.assessedAt, "string");
    });
  });

  test("uses solana as default network in the request URL", async () => {
    let capturedUrl = "";
    await withServer(
      (req, res) => {
        capturedUrl = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_RISK));
      },
      async (url) => {
        await assessWalletRiskFactory(url)({ address: WALLET });
        assert.ok(capturedUrl.includes("network=solana"), `Expected network=solana in: ${capturedUrl}`);
      },
    );
  });

  test("passes custom network when specified", async () => {
    let capturedUrl = "";
    await withServer(
      (req, res) => {
        capturedUrl = req.url ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MOCK_RISK));
      },
      async (url) => {
        await assessWalletRiskFactory(url)({ address: WALLET, network: "ethereum" });
        assert.ok(capturedUrl.includes("network=ethereum"), `Expected network=ethereum in: ${capturedUrl}`);
      },
    );
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(403), async (url) => {
      await assert.rejects(
        () => assessWalletRiskFactory(url)({ address: WALLET }),
        (e: Error) => { assert.ok(e.message.includes("403")); return true; },
      );
    });
  });

  // ── Live tests ──────────────────────────────────────────────

  test("returns risk assessment shape from live endpoint", async () => {
    if (!hasEndpoint) { skip("Risk Assessment API (Scorechain)"); return; }
    const result = await assessWalletRiskFactory(QN_ENDPOINT)({ address: WALLET });
    assert.ok(typeof result.address   === "string");
    assert.ok(typeof result.riskScore === "number");
    assert.ok(["low", "medium", "high", "severe"].includes(result.riskLevel));
    assert.ok(["clean", "flagged", "blocked"].includes(result.amlStatus));
    assert.ok(Array.isArray(result.flags));
  });
});
