const parseJsonResponse = async <T>(res: Response, errorPrefix: string): Promise<T> => {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${errorPrefix} ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
};

const restGet = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  return parseJsonResponse<T>(res, "Quicknode REST error");
};

const stripTrailingSlash = (url: string) => {
  const parsedUrl = new URL(url);
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/$/, "");
  return parsedUrl.toString().replace(/\/$/, "");
};

const isQuicknodeRpcUrl = (url: string) => /quiknode\.pro/i.test(url);

const resolveOpenOceanBase = (endpointUrl: string) => {
  // Strip the trailing slash so addon path checks and appends stay consistent.
  const normalized = stripTrailingSlash(endpointUrl);
  if (/\/addon\/807\/v4\/solana$/i.test(normalized)) return normalized;
  if (isQuicknodeRpcUrl(normalized)) return `${normalized}/addon/807/v4/solana`;
  if (/\/openocean\/v4\/solana$/i.test(normalized)) return normalized;
  return `${normalized}/openocean/v4/solana`;
};

const normalizeDecimalAmount = (amount: string, decimals: number): string => {
  // Accept plain integer or decimal strings like "1", "0.5", or "12.345".
  // Reject negatives, commas, scientific notation, and malformed values like "-1", "1,000", "1e6", or ".".
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid token amount "${amount}"`);
  }

  const [major, minor = ""] = amount.split(".");
  if (minor.length > decimals) {
    throw new Error(`Amount "${amount}" exceeds token precision of ${decimals} decimals`);
  }

  const normalizedMinor = minor.padEnd(decimals, "0");
  const raw = `${major}${normalizedMinor}`.replace(/^0+/, "");
  return raw.length > 0 ? raw : "0";
};

export interface OpenOceanToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface OpenOceanQuoteOptions {
  /** Input token mint address */
  inTokenAddress: string;
  /** Output token mint address */
  outTokenAddress: string;
  /**
   * Amount in human-readable units.
   * e.g. "1" for 1 SOL, "100" for 100 USDC
   */
  amount?: string;
  /**
   * Optional raw amount in smallest units.
   * Use this when you already know the token decimals and want to avoid
   * the token-list lookup.
   */
  amountDecimals?: string | bigint | number;
  /** Slippage tolerance in percent. Default: 1 (1%) */
  slippage?: number;
}

export interface OpenOceanQuote {
  inToken: OpenOceanToken;
  outToken: OpenOceanToken;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  priceImpact: string;
  estimatedGas: string;
  path: Array<{ name: string; part: number }>;
}

interface OpenOceanApiToken extends OpenOceanToken {
  icon?: string;
}

interface OpenOceanApiQuote {
  inToken: OpenOceanApiToken;
  outToken: OpenOceanApiToken;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  // OpenOcean docs currently show price_impact, but we have also seen priceImpact in responses.
  // Treat priceImpact as a compatibility fallback until the upstream API clarifies or deprecates one:
  // https://github.com/openocean-finance/OpenOcean-API-Examples/issues/2
  price_impact?: string;
  priceImpact?: string;
  estimatedGas?: string | number;
  dexes?: Array<{
    dexCode: string;
    route?: Array<{ percent?: number }>;
  }>;
}

/**
 * Token addresses commonly used with OpenOcean on Solana.
 */
export const OPENOCEAN_TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
} as const;

const openOceanTokenListCache = new Map<string, Promise<Map<string, OpenOceanApiToken>>>();

const getOpenOceanTokenMap = async (endpointUrl: string): Promise<Map<string, OpenOceanApiToken>> => {
  const openOceanBase = resolveOpenOceanBase(endpointUrl);
  const cached = openOceanTokenListCache.get(openOceanBase);
  if (cached) return cached;

  const request = restGet<{ code: number; data: OpenOceanApiToken[] }>(
    `${openOceanBase}/tokenList`,
  ).then((response) => {
    const tokens = new Map<string, OpenOceanApiToken>();
    for (const token of response.data ?? []) {
      tokens.set(token.address, token);
    }
    return tokens;
  });

  openOceanTokenListCache.set(openOceanBase, request);
  return request;
};

const resolveOpenOceanAmountDecimals = async (
  endpointUrl: string,
  inTokenAddress: string,
  options: Pick<OpenOceanQuoteOptions, "amount" | "amountDecimals">,
): Promise<string> => {
  if (options.amountDecimals !== undefined) {
    return options.amountDecimals.toString();
  }
  if (!options.amount) {
    throw new Error("OpenOcean requires either amount or amountDecimals");
  }

  const tokenMap = await getOpenOceanTokenMap(endpointUrl);
  const token = tokenMap.get(inTokenAddress);
  if (!token) {
    throw new Error(`OpenOcean token metadata not found for ${inTokenAddress}`);
  }

  return normalizeDecimalAmount(options.amount, token.decimals);
};

const mapOpenOceanQuote = (response: { code: number; data: OpenOceanApiQuote }): OpenOceanQuote => {
  const quote = response.data;
  const { inToken, outToken } = quote;
  return {
    inToken: {
      address: inToken.address,
      name: inToken.name,
      symbol: inToken.symbol,
      decimals: inToken.decimals,
    },
    outToken: {
      address: outToken.address,
      name: outToken.name,
      symbol: outToken.symbol,
      decimals: outToken.decimals,
    },
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    minOutAmount: quote.minOutAmount,
    // Accept both field names for compatibility; see OpenOcean note above.
    priceImpact: quote.price_impact ?? quote.priceImpact ?? "0",
    estimatedGas: quote.estimatedGas !== undefined ? String(quote.estimatedGas) : "0",
    path: (quote.dexes ?? []).map((dex) => ({
      name: dex.dexCode,
      part: dex.route?.reduce((sum, route) => sum + (route.percent ?? 0), 0) ?? 0,
    })),
  };
};

/**
 * Creates a function that fetches a best-price swap quote from OpenOcean V4,
 * aggregating liquidity across 40+ chains and hundreds of DEXes.
 *
 * Note: Returns a quote only. To execute, call `/openocean/v4/solana/swap_quote`
 * with a `userAddress` to receive a signable transaction.
 *
 * Requires: OpenOcean V4 Swap API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getOpenOceanQuote = getOpenOceanQuoteFactory(endpointUrl);
 * const quote = await getOpenOceanQuote({
 *   inTokenAddress: OPENOCEAN_TOKENS.SOL,
 *   outTokenAddress: OPENOCEAN_TOKENS.USDC,
 *   amount: "1",
 *   slippage: 0.5,
 * });
 * console.log(`${quote.inAmount} SOL → ${quote.outAmount} USDC`);
 */
export const getOpenOceanQuoteFactory = (endpointUrl: string) => {
  const getOpenOceanQuote = async (
    options: OpenOceanQuoteOptions,
  ): Promise<OpenOceanQuote> => {
    const openOceanBase = resolveOpenOceanBase(endpointUrl);
    const amountDecimals = await resolveOpenOceanAmountDecimals(
      endpointUrl,
      options.inTokenAddress,
      options,
    );
    const qs = new URLSearchParams({
      inTokenAddress: options.inTokenAddress,
      outTokenAddress: options.outTokenAddress,
      amountDecimals,
      slippage: String(options.slippage ?? 1),
      gasPriceDecimals: "100000",
    });
    const res = await restGet<{ code: number; data: OpenOceanApiQuote }>(
      `${openOceanBase}/quote?${qs}`,
    );
    return mapOpenOceanQuote(res);
  };

  return getOpenOceanQuote;
};

/**
 * Creates a function that fetches a serialized (unsigned) OpenOcean swap transaction.
 * Pass the returned base64 transaction to your wallet for signing and broadcasting.
 *
 * Requires: OpenOcean V4 Swap API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getOpenOceanSwapTx = getOpenOceanSwapTransactionFactory(endpointUrl);
 * const { data } = await getOpenOceanSwapTx({
 *   inTokenAddress: OPENOCEAN_TOKENS.SOL,
 *   outTokenAddress: OPENOCEAN_TOKENS.USDC,
 *   amount: "1",
 *   userAddress: "YOUR_WALLET_ADDRESS",
 * });
 * // data.data is a base64-encoded VersionedTransaction ready to sign
 */
export const getOpenOceanSwapTransactionFactory = (endpointUrl: string) => {
  const getOpenOceanSwapTransaction = async (
    options: OpenOceanQuoteOptions & { userAddress: string },
  ): Promise<{ data: { data: string } }> => {
    const openOceanBase = resolveOpenOceanBase(endpointUrl);
    const amountDecimals = await resolveOpenOceanAmountDecimals(
      endpointUrl,
      options.inTokenAddress,
      options,
    );
    const qs = new URLSearchParams({
      inTokenAddress: options.inTokenAddress,
      outTokenAddress: options.outTokenAddress,
      amountDecimals,
      slippage: String(options.slippage ?? 1),
      account: options.userAddress,
      gasPriceDecimals: "100000",
    });
    return restGet<{ data: { data: string } }>(`${openOceanBase}/swap_quote?${qs}`);
  };

  return getOpenOceanSwapTransaction;
};
