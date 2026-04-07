import assert from "node:assert";
import { createServer, type RequestListener } from "node:http";
import { describe, test } from "node:test";
import {
  OPENOCEAN_TOKENS,
  getOpenOceanQuoteFactory,
  getOpenOceanSwapTransactionFactory,
} from "./openocean";

const QN_ENDPOINT = process.env.QN_ENDPOINT_URL ?? "";
const hasEndpoint = QN_ENDPOINT.length > 0;
const WALLET = "E645TckHQnDcavVv92Etc6xSWQaq8zzPtPRGBheviRAk";
const SOL_M = OPENOCEAN_TOKENS.SOL;
const USDC_M = OPENOCEAN_TOKENS.USDC;

const MOCK_OO_QUOTE = {
  inToken: { address: SOL_M, name: "Wrapped SOL", symbol: "SOL", decimals: 9 },
  outToken: { address: USDC_M, name: "USD Coin", symbol: "USDC", decimals: 6 },
  inAmount: "1",
  outAmount: "150",
  minOutAmount: "148.5",
  priceImpact: "0.01",
  estimatedGas: "5000",
  path: [],
};

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

const restOk = (data: unknown): RequestListener => (_, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const httpErr = (status: number): RequestListener => (_, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Error" }));
};

const skip = (addon = "") => {
  const note = addon ? ` (${addon} add-on required)` : "";
  console.log(`Skipping live test — set QN_ENDPOINT_URL to run${note}`);
};

describe("getOpenOceanQuoteFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getOpenOceanQuoteFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("unwraps data field and parses quote from mock REST response", async () => {
    await withServer(restOk({ code: 200, data: MOCK_OO_QUOTE }), async (url) => {
      const quote = await getOpenOceanQuoteFactory(url)({
        inTokenAddress: SOL_M,
        outTokenAddress: USDC_M,
        amount: "1",
      });
      assert.equal(quote.inToken.symbol, "SOL");
      assert.equal(quote.outToken.symbol, "USDC");
      assert.equal(quote.inAmount, MOCK_OO_QUOTE.inAmount);
      assert.equal(quote.outAmount, "150");
      assert.equal(typeof quote.priceImpact, "string");
      assert.ok(Array.isArray(quote.path));
    });
  });

  test("uses amountDecimals and addon path on Quicknode-style endpoints", async () => {
    const requests: string[] = [];
    await withServer(
      (req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        if ((req.url ?? "").includes("/tokenList")) {
          res.end(JSON.stringify({
            code: 200,
            data: [{ address: SOL_M, name: "Wrapped SOL", symbol: "SOL", decimals: 9 }],
          }));
          return;
        }
        res.end(JSON.stringify({ code: 200, data: MOCK_OO_QUOTE }));
      },
      async (url) => {
        const quickNodeStyleUrl = `${url}/token/`;
        await getOpenOceanQuoteFactory(quickNodeStyleUrl)({
          inTokenAddress: SOL_M,
          outTokenAddress: USDC_M,
          amount: "1",
        });
      },
    );

    assert.equal(requests[0], "/token/addon/807/v4/solana/tokenList");
    assert.ok(requests[1]?.startsWith("/token/addon/807/v4/solana/quote?"));
    assert.ok(requests[1]?.includes("amountDecimals=1000000000"));
    assert.ok(requests[1]?.includes("gasPriceDecimals=100000"));
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(400), async (url) => {
      await assert.rejects(
        () =>
          getOpenOceanQuoteFactory(url)({
            inTokenAddress: SOL_M,
            outTokenAddress: USDC_M,
            amount: "1",
          }),
        (e: Error) => {
          assert.ok(e.message.includes("400"));
          return true;
        },
      );
    });
  });

  test("returns a valid quote from live endpoint", async () => {
    if (!hasEndpoint) {
      skip("OpenOcean V4 Swap API");
      return;
    }
    const quote = await getOpenOceanQuoteFactory(QN_ENDPOINT)({
      inTokenAddress: SOL_M,
      outTokenAddress: USDC_M,
      amount: "0.01",
      slippage: 1,
    });
    assert.ok(typeof quote.inToken.symbol === "string");
    assert.ok(typeof quote.outToken.symbol === "string");
    assert.ok(typeof quote.outAmount === "string");
    assert.ok(typeof quote.priceImpact === "string");
  });
});

describe("getOpenOceanSwapTransactionFactory", () => {
  test("factory returns a function", () => {
    assert.equal(typeof getOpenOceanSwapTransactionFactory("https://example.quiknode.pro/token/"), "function");
  });

  test("parses nested transaction data from mock REST response", async () => {
    await withServer(restOk({ data: { data: "BASE64ENCODEDTX" } }), async (url) => {
      const result = await getOpenOceanSwapTransactionFactory(url)({
        inTokenAddress: SOL_M,
        outTokenAddress: USDC_M,
        amount: "1",
        userAddress: WALLET,
      });
      assert.equal(result.data.data, "BASE64ENCODEDTX");
    });
  });

  test("uses swap_quote path with amountDecimals", async () => {
    const requests: string[] = [];
    await withServer(
      (req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        if ((req.url ?? "").includes("/tokenList")) {
          res.end(JSON.stringify({
            code: 200,
            data: [{ address: SOL_M, name: "Wrapped SOL", symbol: "SOL", decimals: 9 }],
          }));
          return;
        }
        res.end(JSON.stringify({ data: { data: "BASE64ENCODEDTX" } }));
      },
      async (url) => {
        const quickNodeStyleUrl = `${url}/token/`;
        await getOpenOceanSwapTransactionFactory(quickNodeStyleUrl)({
          inTokenAddress: SOL_M,
          outTokenAddress: USDC_M,
          amount: "1",
          userAddress: WALLET,
        });
      },
    );

    assert.equal(requests[0], "/token/addon/807/v4/solana/tokenList");
    assert.ok(requests[1]?.startsWith("/token/addon/807/v4/solana/swap_quote?"));
    assert.ok(requests[1]?.includes(`account=${WALLET}`));
    assert.ok(requests[1]?.includes("amountDecimals=1000000000"));
  });

  test("throws on HTTP error", async () => {
    await withServer(httpErr(400), async (url) => {
      await assert.rejects(
        () =>
          getOpenOceanSwapTransactionFactory(url)({
            inTokenAddress: SOL_M,
            outTokenAddress: USDC_M,
            amount: "1",
            userAddress: WALLET,
          }),
        (e: Error) => {
          assert.ok(e.message.includes("400"));
          return true;
        },
      );
    });
  });
});
