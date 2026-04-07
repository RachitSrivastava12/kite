/**
 * Quicknode-specific helpers for Kite
 *
 * These functions require a Quicknode endpoint with the relevant add-ons enabled.
 * Get a free endpoint at: https://dashboard.quicknode.com
 *
 * Add-ons used:
 *   - Solana Priority Fee API                     → getQuickNodePriorityFeesFactory
 *   - Metaplex Digital Asset API / DAS            → getAssetsByOwnerFactory, getAssetFactory,
 *                                                    getAssetsByCollectionFactory, searchAssetsFactory,
 *                                                    getAssetProofFactory
 *   - Pump Fun API                                → getPumpFunSwapTransactionFactory
 *   - OpenOcean V4 Swap API                       → getOpenOceanQuoteFactory
 *   - Solana MEV Protection by Merkle             → sendMerkleTransactionFactory
 *   - Solana MEV Resilience by Blink Labs         → sendBlinkLabsTransactionFactory
 *   - Multi-Chain Stablecoin Balance              → getStablecoinBalancesFactory
 *   - Metis - DeFi Swap / Jupiter V6              → getJupiterSwapQuoteFactory
 *   - Lil' JIT - JITO Bundles & Transactions      → sendJitoBundleFactory, getBundleStatusesFactory
 *   - Iris Transaction Sender by Astralane        → sendIrisTransactionFactory
 *   - GoldRush - Multichain Data by Covalent      → getGoldRushBalancesFactory,
 *                                                    getGoldRushTransactionsFactory
 *   - DeFi Swap Meta-Aggregation by Titan         → getTitanSwapQuoteFactory,
 *                                                    subscribeTitanQuotesFactory
 *   - Risk Assessment API by Scorechain           → assessWalletRiskFactory
 */

export {
  OPENOCEAN_TOKENS,
  getOpenOceanQuoteFactory,
  getOpenOceanSwapTransactionFactory,
} from "./quicknode/addons/openocean";
export type {
  OpenOceanQuote,
  OpenOceanQuoteOptions,
  OpenOceanToken,
} from "./quicknode/addons/openocean";

// ─────────────────────────────────────────────────────────────
// Internal fetch helpers
// ─────────────────────────────────────────────────────────────

const parseJsonResponse = async <T>(res: Response, errorPrefix: string): Promise<T> => {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${errorPrefix} ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
};

/** JSON-RPC POST to a Quicknode endpoint */
const rpcFetch = async <T>(
  endpointUrl: string,
  rpcMethod: string,
  params: unknown,
): Promise<T> => {
  const res = await fetch(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: rpcMethod, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await parseJsonResponse<{ result?: T; error?: { code: number; message: string } }>(
    res,
    "Quicknode RPC error",
  );
  if (data.error) {
    throw new Error(`Quicknode method error ${data.error.code}: ${data.error.message}`);
  }
  return data.result as T;
};

/** REST GET request to a Quicknode add-on endpoint */
const restGet = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  return parseJsonResponse<T>(res, "Quicknode REST error");
};

/** REST POST request to a Quicknode add-on endpoint */
const restPost = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return parseJsonResponse<T>(res, "Quicknode REST error");
};

/** Strip a trailing slash from a URL */
const stripTrailingSlash = (url: string) => {
  const parsedUrl = new URL(url);
  parsedUrl.pathname = parsedUrl.pathname.replace(/\/$/, "");
  return parsedUrl.toString().replace(/\/$/, "");
};

const isQuicknodeRpcUrl = (url: string) => /quiknode\.pro/i.test(url);

const resolveMetisBase = (endpointUrl: string) => {
  // Strip the trailing slash so we can compare and extend the path consistently.
  const normalized = stripTrailingSlash(endpointUrl);
  return isQuicknodeRpcUrl(normalized) ? "https://public.jupiterapi.com" : normalized;
};

const buildProtectedSendTransactionParams = (options: MevTxOptions) => {
  if (options.tipLamports !== undefined) {
    throw new Error(
      "Quicknode's Merkle and Blink add-ons use the standard sendTransaction RPC method; include any tip inside the signed transaction itself."
    );
  }

  return [options.serializedTransaction, { encoding: "base64" }];
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  PRIORITY FEE API
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface QuickNodePriorityFees {
  /** Cheapest fee — may be slow during congestion */
  low: number;
  /** Medium fee — fine on a quiet network */
  medium: number;
  /** Recommended fee — best default for most transactions */
  recommended: number;
  /** High fee — use when you need confirmation in the next block */
  high: number;
  /** Extreme fee — use during peak congestion */
  extreme: number;
  /**
   * Network congestion score from 0 to 1.
   * 0 = very quiet, 1 = extremely busy.
   */
  networkCongestion: number;
}

export interface QuickNodePriorityFeeOptions {
  /**
   * Filter fee estimate by a specific account address (e.g. a program ID).
   * More accurate than the global estimate when you know which accounts
   * your transaction will touch.
   */
  account?: string;
  /**
   * Number of recent blocks to sample for fee estimation.
   * Default: 100
   */
  lastNBlocks?: number;
}

interface QuickNodePriorityFeesRpcResponse {
  recommended?: number;
  per_compute_unit: {
    extreme: number;
    high: number;
    medium: number;
    low: number;
    recommended?: number;
  };
  network_congestion?: number;
}

/**
 * Creates a function that fetches real-time priority fee recommendations
 * from Quicknode's Priority Fee API.
 *
 * Returns 5 fee levels (low to extreme) plus a network congestion score,
 * based on recent confirmed transactions on the network.
 *
 * Requires: Solana Priority Fee API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @param endpointUrl - Your Quicknode endpoint URL
 * @returns Function to fetch live priority fees
 *
 * @example
 * const getPriorityFees = getQuickNodePriorityFeesFactory(
 *   "https://your-endpoint.solana-mainnet.quiknode.pro/TOKEN/"
 * );
 *
 * const fees = await getPriorityFees();
 * console.log(`Recommended: ${fees.recommended} µlamports/CU`);
 *
 * // Filter by program for more accurate estimates
 * const jupFees = await getPriorityFees({
 *   account: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
 * });
 */
export const getQuickNodePriorityFeesFactory = (endpointUrl: string) => {
  const getQuickNodePriorityFees = async (
    options: QuickNodePriorityFeeOptions = {}
  ): Promise<QuickNodePriorityFees> => {
    const params: Record<string, unknown> = {
      last_n_blocks: options.lastNBlocks ?? 100,
      api_version: 2,
    };
    if (options.account) {
      params.account = options.account;
    }

    const result = await rpcFetch<QuickNodePriorityFeesRpcResponse>(
      endpointUrl,
      "qn_estimatePriorityFees",
      params
    );

    return {
      low: result.per_compute_unit.low,
      medium: result.per_compute_unit.medium,
      recommended: result.recommended ?? result.per_compute_unit.recommended ?? result.per_compute_unit.medium,
      high: result.per_compute_unit.high,
      extreme: result.per_compute_unit.extreme,
      networkCongestion: result.network_congestion ?? 0,
    };
  };

  return getQuickNodePriorityFees;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  METAPLEX DIGITAL ASSET STANDARD (DAS) API
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface DigitalAssetContent {
  json_uri: string;
  metadata: {
    name: string;
    symbol: string;
    description?: string;
    image?: string;
    attributes?: Array<{ trait_type: string; value: string | number }>;
  };
}

export interface DigitalAsset {
  /** The mint address of the asset */
  id: string;
  /** Asset interface type (V1_NFT, FungibleToken, etc.) */
  interface: string;
  content: DigitalAssetContent;
  ownership: {
    owner: string;
    frozen: boolean;
    delegated: boolean;
    delegate?: string;
  };
  compression?: {
    compressed: boolean;
    tree: string;
    leaf_id: number;
    seq: number;
    data_hash: string;
    creator_hash: string;
    asset_hash: string;
  };
  royalty?: {
    basis_points: number;
    percent: number;
    primary_sale_happened: boolean;
  };
  creators?: Array<{ address: string; share: number; verified: boolean }>;
  grouping?: Array<{ group_key: string; group_value: string }>;
  mutable: boolean;
  burnt: boolean;
}

export interface AssetsPage {
  total: number;
  limit: number;
  page: number;
  items: DigitalAsset[];
}

/** @deprecated Use {@link AssetsPage} */
export type GetAssetsByOwnerResult = AssetsPage;

export interface GetAssetsByOwnerOptions {
  /** The wallet address to query */
  ownerAddress: string;
  /** Max results per page. Default: 100 */
  limit?: number;
  /** Page number, starting at 1. Default: 1 */
  page?: number;
}

export interface GetAssetsByCollectionOptions {
  /** The collection mint address */
  collectionMint: string;
  /** Max results per page. Default: 100 */
  limit?: number;
  /** Page number, starting at 1. Default: 1 */
  page?: number;
}

export interface SearchAssetsOptions {
  ownerAddress?: string;
  creatorAddress?: string;
  /** Collection mint address */
  collection?: string;
  /** Filter by asset type */
  tokenType?: "fungible" | "nonFungible" | "regularNFT" | "compressedNFT" | "all";
  /** Filter by compression status */
  compressed?: boolean;
  /** Max results per page. Default: 100 */
  limit?: number;
  /** Page number, starting at 1. Default: 1 */
  page?: number;
}

export interface AssetProof {
  root: string;
  proof: string[];
  node_index: number;
  leaf: string;
  tree_id: string;
}

export interface WalletTokenAccount {
  mint: string;
  tokenAccount: string;
  balance: number;
  decimals: number;
  uiAmount: number;
}

export interface GetWalletTokenAccountsOptions {
  ownerAddress: string;
  mint?: string;
  programId?: string;
}

/**
 * Creates a function that queries all digital assets (NFTs, cNFTs, tokens)
 * owned by a wallet using Quicknode's Metaplex DAS API.
 *
 * Requires: Metaplex Digital Asset Standard (DAS) API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getAssetsByOwner = getAssetsByOwnerFactory(endpointUrl);
 * const { items, total } = await getAssetsByOwner({ ownerAddress: "..." });
 */
export const getAssetsByOwnerFactory = (endpointUrl: string) => {
  const getAssetsByOwner = async (
    options: GetAssetsByOwnerOptions
  ): Promise<AssetsPage> => {
    return rpcFetch<AssetsPage>(
      endpointUrl,
      "getAssetsByOwner",
      {
        ownerAddress: options.ownerAddress,
        limit:        options.limit ?? 100,
        page:         options.page  ?? 1,
      }
    );
  };

  return getAssetsByOwner;
};

/**
 * Creates a function that fetches full details for a single digital asset
 * by its mint address.
 *
 * Requires: Metaplex Digital Asset Standard (DAS) API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getAsset = getAssetFactory(endpointUrl);
 * const asset = await getAsset("NFTMintAddressHere");
 */
export const getAssetFactory = (endpointUrl: string) => {
  const getAsset = async (mintAddress: string): Promise<DigitalAsset> => {
    return rpcFetch<DigitalAsset>(
      endpointUrl,
      "getAsset",
      { id: mintAddress }
    );
  };

  return getAsset;
};

/**
 * Creates a function that fetches all assets in a collection.
 *
 * Requires: Metaplex Digital Asset Standard (DAS) API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getAssetsByCollection = getAssetsByCollectionFactory(endpointUrl);
 * const { items } = await getAssetsByCollection({
 *   collectionMint: "COLLECTION_MINT_ADDRESS",
 *   limit: 50,
 * });
 */
export const getAssetsByCollectionFactory = (endpointUrl: string) => {
  const getAssetsByCollection = async (
    options: GetAssetsByCollectionOptions
  ): Promise<AssetsPage> => {
    return rpcFetch<AssetsPage>(
      endpointUrl,
      "getAssetsByGroup",
      {
        groupKey: "collection",
        groupValue: options.collectionMint,
        limit: options.limit ?? 100,
        page: options.page ?? 1,
      }
    );
  };

  return getAssetsByCollection;
};

/**
 * Creates a function that searches assets by owner, creator, or collection
 * with optional type filters.
 *
 * Requires: Metaplex Digital Asset Standard (DAS) API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const searchAssets = searchAssetsFactory(endpointUrl);
 * // Find all compressed NFTs for a wallet
 * const { items } = await searchAssets({
 *   ownerAddress: "WALLET_ADDRESS",
 *   compressed: true,
 * });
 */
export const searchAssetsFactory = (endpointUrl: string) => {
  const searchAssets = async (
    options: SearchAssetsOptions
  ): Promise<AssetsPage> => {
    const params: Record<string, unknown> = {
      limit: options.limit ?? 100,
      page: options.page ?? 1,
    };
    if (options.ownerAddress)   params.ownerAddress   = options.ownerAddress;
    if (options.creatorAddress) params.creatorAddress = options.creatorAddress;
    if (options.collection)     params.grouping       = ["collection", options.collection];
    if (options.compressed !== undefined) params.compressed = options.compressed;
    if (options.tokenType)      params.tokenType      = options.tokenType;

    return rpcFetch<AssetsPage>(endpointUrl, "searchAssets", params);
  };

  return searchAssets;
};

/**
 * Creates a function that returns the Merkle proof for a compressed NFT.
 * Required to verify ownership and build leaf update instructions.
 *
 * Requires: Metaplex Digital Asset Standard (DAS) API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getAssetProof = getAssetProofFactory(endpointUrl);
 * const proof = await getAssetProof("CNFT_ASSET_ID");
 * console.log(proof.root, proof.proof);
 */
export const getAssetProofFactory = (endpointUrl: string) => {
  const getAssetProof = async (assetId: string): Promise<AssetProof> => {
    return rpcFetch<AssetProof>(endpointUrl, "getAssetProof", { id: assetId });
  };

  return getAssetProof;
};

/**
 * Creates a function that fetches SPL token accounts for a wallet.
 *
 * This is a convenience wrapper over the standard Solana
 * `getTokenAccountsByOwner` RPC method using `jsonParsed` encoding.
 *
 * @example
 * const getWalletTokenAccounts = getWalletTokenAccountsFactory(endpointUrl);
 * const accounts = await getWalletTokenAccounts({ ownerAddress: "..." });
 */
export const getWalletTokenAccountsFactory = (endpointUrl: string) => {
  const getWalletTokenAccounts = async (
    options: GetWalletTokenAccountsOptions
  ): Promise<WalletTokenAccount[]> => {
    const filter = options.mint ? { mint: options.mint } : { programId: options.programId ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
    const result = await rpcFetch<{
      value: Array<{
        pubkey: string;
        account: {
          data: {
            parsed?: {
              info?: {
                mint?: string;
                tokenAmount?: {
                  amount?: string;
                  decimals?: number;
                  uiAmount?: number;
                };
              };
            };
          };
        };
      }>;
    }>(endpointUrl, "getTokenAccountsByOwner", [
      options.ownerAddress,
      filter,
      { encoding: "jsonParsed" },
    ]);

    return (result.value ?? []).map((item) => {
      const info = item.account.data.parsed?.info;
      const tokenAmount = info?.tokenAmount;
      return {
        mint: info?.mint ?? "",
        tokenAccount: item.pubkey,
        balance: Number(tokenAmount?.amount ?? 0),
        decimals: tokenAmount?.decimals ?? 0,
        uiAmount: tokenAmount?.uiAmount ?? 0,
      };
    });
  };

  return getWalletTokenAccounts;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  PUMP FUN API
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface PumpFunToken {
  mint:             string;
  name:             string;
  symbol:           string;
  description?:     string;
  image?:           string;
  creator:          string;
  /** Unix timestamp of creation */
  createdTimestamp: number;
  marketCapSol:     number;
  usdMarketCap?:    number;
  price:            number;
  bondingCurve: {
    virtualTokenReserves: string;
    virtualSolReserves:   string;
    realTokenReserves:    string;
    realSolReserves:      string;
    tokenTotalSupply:     string;
    /** true if the bonding curve is complete and token has graduated to Raydium */
    complete:             boolean;
  };
  raydiumPool?: string;
  graduated:    boolean;
  website?:     string;
  twitter?:     string;
  telegram?:    string;
}

export interface PumpFunTokenHolder {
  address:    string;
  balance:    string;
  percentage: number;
}

export interface PumpFunTrade {
  signature:   string;
  mint:        string;
  solAmount:   string;
  tokenAmount: string;
  isBuy:       boolean;
  user:        string;
  timestamp:   number;
  slot:        number;
}

export interface GetPumpFunTokensOptions {
  /** Max tokens to return. Default: 20 */
  limit?: number;
  /** Pagination offset. Default: 0 */
  offset?: number;
  /** Include NSFW tokens. Default: false */
  includeNsfw?: boolean;
}

export interface GetPumpFunTokensByCreatorOptions {
  /** Creator wallet address */
  creator: string;
  /** Max tokens to return. Default: 20 */
  limit?: number;
  /** Pagination offset. Default: 0 */
  offset?: number;
}

export interface GetPumpFunTradesOptions {
  /** Max trades to return. Default: 20 */
  limit?: number;
  /** Pagination offset. Default: 0 */
  offset?: number;
}

/**
 * Creates a function that fetches the latest pump.fun tokens by launch time.
 *
 * Requires: Pump Fun API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getPumpFunTokens = getPumpFunTokensFactory(endpointUrl);
 * const tokens = await getPumpFunTokens({ limit: 10 });
 * tokens.forEach(t => console.log(t.name, t.marketCapSol));
 */
export const getPumpFunTokensFactory = (endpointUrl: string) => {
  const getPumpFunTokens = async (
    options: GetPumpFunTokensOptions = {}
  ): Promise<PumpFunToken[]> => {
    const qs = new URLSearchParams({
      limit: String(options.limit ?? 20),
      offset: String(options.offset ?? 0),
    });
    if (options.includeNsfw !== undefined) {
      qs.set("include_nsfw", String(options.includeNsfw));
    }
    return restGet<PumpFunToken[]>(`${stripTrailingSlash(endpointUrl)}/pump-fun/coins?${qs}`);
  };

  return getPumpFunTokens;
};

/**
 * Creates a function that fetches a single pump.fun token by its mint address.
 *
 * Requires: Pump Fun API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getPumpFunToken = getPumpFunTokenFactory(endpointUrl);
 * const token = await getPumpFunToken("TOKEN_MINT_ADDRESS");
 * console.log(token.name, token.bondingCurve.complete);
 */
export const getPumpFunTokenFactory = (endpointUrl: string) => {
  const getPumpFunToken = async (mint: string): Promise<PumpFunToken> => {
    return restGet<PumpFunToken>(`${stripTrailingSlash(endpointUrl)}/pump-fun/coins/${mint}`);
  };

  return getPumpFunToken;
};

/**
 * Creates a function that fetches all pump.fun tokens created by a specific wallet.
 *
 * Requires: Pump Fun API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getTokensByCreator = getPumpFunTokensByCreatorFactory(endpointUrl);
 * const tokens = await getTokensByCreator({ creator: "CREATOR_WALLET" });
 */
export const getPumpFunTokensByCreatorFactory = (endpointUrl: string) => {
  const getPumpFunTokensByCreator = async (
    options: GetPumpFunTokensByCreatorOptions
  ): Promise<PumpFunToken[]> => {
    const qs = new URLSearchParams({
      creator: options.creator,
      limit: String(options.limit ?? 20),
      offset: String(options.offset ?? 0),
    });
    return restGet<PumpFunToken[]>(`${stripTrailingSlash(endpointUrl)}/pump-fun/coins?${qs}`);
  };

  return getPumpFunTokensByCreator;
};

/**
 * Creates a function that fetches the top holders of a pump.fun token.
 *
 * Requires: Pump Fun API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getPumpFunTokenHolders = getPumpFunTokenHoldersFactory(endpointUrl);
 * const holders = await getPumpFunTokenHolders("TOKEN_MINT_ADDRESS");
 * console.log(`Top holder: ${holders[0].address} (${holders[0].percentage}%)`);
 */
export const getPumpFunTokenHoldersFactory = (endpointUrl: string) => {
  const getPumpFunTokenHolders = async (
    mint: string
  ): Promise<PumpFunTokenHolder[]> => {
    return restGet<PumpFunTokenHolder[]>(
      `${stripTrailingSlash(endpointUrl)}/pump-fun/coins/${mint}/holders`
    );
  };

  return getPumpFunTokenHolders;
};

/**
 * Creates a function that fetches recent trades for a pump.fun token.
 *
 * Requires: Pump Fun API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getPumpFunTrades = getPumpFunTokenTradesFactory(endpointUrl);
 * const trades = await getPumpFunTrades("TOKEN_MINT_ADDRESS", { limit: 50 });
 * trades.forEach(t => console.log(t.isBuy ? "BUY" : "SELL", t.solAmount));
 */
export const getPumpFunTokenTradesFactory = (endpointUrl: string) => {
  const getPumpFunTokenTrades = async (
    mint: string,
    options: GetPumpFunTradesOptions = {}
  ): Promise<PumpFunTrade[]> => {
    const qs = new URLSearchParams({
      mint,
      limit: String(options.limit ?? 20),
      offset: String(options.offset ?? 0),
    });
    return restGet<PumpFunTrade[]>(
      `${stripTrailingSlash(endpointUrl)}/pump-fun/trades/all?${qs}`
    );
  };

  return getPumpFunTokenTrades;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  MULTI-CHAIN STABLECOIN BALANCE API
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface StablecoinBalance {
  /** Chain identifier (e.g. "solana", "ethereum") */
  chain: string;
  contractAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: string;
  usdValue: number;
  logo?: string;
}

export interface GetStablecoinBalancesOptions {
  /** Wallet address to query */
  walletAddress: string;
  /**
   * Optional chain filter. Pass specific chain IDs to narrow the search.
   * If omitted, all supported chains are queried.
   * Examples: ["solana", "ethereum", "polygon", "arbitrum"]
   */
  chains?: string[];
}

export interface StablecoinBalancesResult {
  walletAddress: string;
  totalUsdValue?: number;
  timestamp?: string;
  balances: StablecoinBalance[];
}

interface StablecoinRpcBalance {
  token: string;
  contract_address?: string;
  decimals: number;
  balance_raw: string;
  balance_formatted: string;
  timestamp?: string;
}

interface StablecoinRpcResponse {
  address: string;
  chains: Record<string, { chain_id?: number; balances: StablecoinRpcBalance[] }>;
  total_balances?: StablecoinRpcBalance[];
  timestamp?: string;
}

/**
 * Creates a function that queries stablecoin holdings (USDT, USDC, DAI, etc.)
 * for a wallet across 10+ blockchain networks in a single call.
 *
 * Requires: Multi-Chain Stablecoin Balance API add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getStablecoinBalances = getStablecoinBalancesFactory(endpointUrl);
 * const result = await getStablecoinBalances({ walletAddress: "WALLET_ADDRESS" });
 * console.log(`Stablecoin entries found: ${result.balances.length}`);
 * result.balances.forEach(b => console.log(b.chain, b.symbol, b.usdValue));
 */
export const getStablecoinBalancesFactory = (endpointUrl: string) => {
  const getStablecoinBalances = async (
    options: GetStablecoinBalancesOptions
  ): Promise<StablecoinBalancesResult> => {
    const params: Record<string, unknown> = { address: options.walletAddress };
    if (options.chains?.length) params.chains = options.chains;
    const result = await rpcFetch<StablecoinRpcResponse>(
      endpointUrl,
      "getStablecoinBalances",
      params
    );

    const balances = Object.entries(result.chains ?? {}).flatMap(([chain, chainData]) =>
      (chainData.balances ?? []).map((balance) => ({
        chain,
        contractAddress: balance.contract_address ?? "",
        name: balance.token,
        symbol: balance.token,
        decimals: balance.decimals,
        balance: balance.balance_raw,
        logo: undefined,
        usdValue: 0,
      }))
    );

    return {
      walletAddress: result.address,
      totalUsdValue: undefined,
      timestamp: result.timestamp,
      balances,
    };
  };

  return getStablecoinBalances;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  METIS — JUPITER V6 SWAP API
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface JupiterSwapRoute {
  swapInfo: {
    label: string;
    inputMint: string;
    outAmount: string;
  };
  percent: number;
}

export interface JupiterSwapQuote {
  inputMint:      string;
  outputMint:     string;
  /** Amount of input tokens consumed (raw, without decimals) */
  inAmount:       string;
  /** Amount of output tokens received (raw, without decimals) */
  outAmount:      string;
  /** Price impact as a percentage string (e.g. "0.01") */
  priceImpactPct: string;
  slippageBps:    number;
  routePlan:      JupiterSwapRoute[];
}

export interface GetJupiterSwapQuoteOptions {
  /** Input token mint address */
  inputMint: string;
  /** Output token mint address */
  outputMint: string;
  /** Amount in lamports / raw smallest units */
  amount: bigint | number;
  /** Slippage tolerance in basis points. Default: 50 (0.5%) */
  slippageBps?: number;
}

export interface PumpFunSwapOptions {
  wallet: string;
  type: "BUY" | "SELL";
  mint: string;
  inAmount: string;
  priorityFeeLevel?: "low" | "medium" | "high" | "veryHigh";
  slippageBps?: number;
  commitment?: "processed" | "confirmed" | "finalized";
  feeAccount?: string;
  platformFeeBps?: number;
}

/**
 * Creates a function that fetches a Jupiter V6 swap quote via Quicknode's
 * Metis add-on. Returns route information and expected output amounts.
 *
 * Note: This returns the quote only. To execute the swap, pass the quote
 * response to the `/swap` endpoint along with a signed transaction.
 *
 * Requires: Metis — DeFi Swap Meta-Aggregation API
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * Useful token addresses:
 * - SOL:  So11111111111111111111111111111111111111112
 * - USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 * - USDT: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
 *
 * @example
 * const getJupiterSwapQuote = getJupiterSwapQuoteFactory(endpointUrl);
 * const quote = await getJupiterSwapQuote({
 *   inputMint:  "So11111111111111111111111111111111111111112",  // SOL
 *   outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
 *   amount:     1_000_000_000n, // 1 SOL in lamports
 * });
 * console.log(`You get: ${quote.outAmount} USDC units`);
 * console.log(`Price impact: ${quote.priceImpactPct}%`);
 */
export const getJupiterSwapQuoteFactory = (endpointUrl: string) => {
  const getJupiterSwapQuote = async (
    options: GetJupiterSwapQuoteOptions
  ): Promise<JupiterSwapQuote> => {
    const metisBase = resolveMetisBase(endpointUrl);
    const qs = new URLSearchParams({
      inputMint: options.inputMint,
      outputMint: options.outputMint,
      amount: options.amount.toString(),
      slippageBps: String(options.slippageBps ?? 50),
    });
    return restGet<JupiterSwapQuote>(
      `${metisBase}/quote?${qs}`
    );
  };

  return getJupiterSwapQuote;
};

/**
 * Creates a function that fetches a serialized (unsigned) Jupiter swap transaction.
 * You can sign and send this transaction with your preferred wallet.
 *
 * Requires: Metis — DeFi Swap Meta-Aggregation API
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getJupiterSwapTx = getJupiterSwapTransactionFactory(endpointUrl);
 * const { swapTransaction } = await getJupiterSwapTx({
 *   quoteResponse:  quote,         // from getJupiterSwapQuoteFactory
 *   userPublicKey:  "USER_WALLET",
 * });
 * // swapTransaction is a base64-encoded VersionedTransaction ready to sign
 */
export const getJupiterSwapTransactionFactory = (endpointUrl: string) => {
  const getJupiterSwapTransaction = async (options: {
    quoteResponse:              JupiterSwapQuote;
    userPublicKey:              string;
    wrapAndUnwrapSol?:          boolean;
    dynamicComputeUnitLimit?:   boolean;
    prioritizationFeeLamports?: number | "auto";
  }): Promise<{ swapTransaction: string }> => {
    const metisBase = resolveMetisBase(endpointUrl);
    return restPost<{ swapTransaction: string }>(
      `${metisBase}/swap`,
      {
        quoteResponse: options.quoteResponse,
        userPublicKey: options.userPublicKey,
        wrapAndUnwrapSol: options.wrapAndUnwrapSol ?? true,
        dynamicComputeUnitLimit: options.dynamicComputeUnitLimit ?? true,
        prioritizationFeeLamports: options.prioritizationFeeLamports ?? "auto",
      }
    );
  };

  return getJupiterSwapTransaction;
};

/**
 * Creates a function that generates a pump.fun swap transaction through Metis.
 *
 * Returns a base64-encoded transaction ready to sign.
 */
export const getPumpFunSwapTransactionFactory = (endpointUrl: string) => {
  const getPumpFunSwapTransaction = async (
    options: PumpFunSwapOptions
  ): Promise<{ tx: string }> => {
    const metisBase = resolveMetisBase(endpointUrl);
    return restPost<{ tx: string }>(
      `${metisBase}/pump-fun/swap`,
      {
        wallet: options.wallet,
        type: options.type,
        mint: options.mint,
        inAmount: options.inAmount,
        priorityFeeLevel: options.priorityFeeLevel,
        slippageBps: options.slippageBps,
        commitment: options.commitment,
        feeAccount: options.feeAccount,
        platformFeeBps: options.platformFeeBps,
      }
    );
  };

  return getPumpFunSwapTransaction;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  LIL' JIT — JITO BUNDLES & TRANSACTIONS
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface JitoBundleStatus {
  bundleId: string;
  /** "Invalid" | "Failed" | "Pending" | "Landed" | "Winning" */
  status:   string;
  landedSlot?: number;
}

export interface JitoInflightBundleStatus {
  bundleId: string;
  status: string;
  landedSlot?: number;
}

export interface JitoTipFloor {
  time: string;
  landedTips25thPercentile: number;
  landedTips50thPercentile: number;
  landedTips75thPercentile: number;
  landedTips95thPercentile: number;
  landedTips99thPercentile: number;
  emaLandedTips50thPercentile: number;
}

/**
 * Creates a function that sends a Jito bundle of transactions.
 * Bundles provide atomic execution — either all transactions land or none do.
 * Also provides MEV protection via tip payments to validators.
 *
 * Each transaction in the bundle must already be signed and serialized to
 * a base64 string. The last transaction should include a tip to a Jito
 * tip account (96 SOL tip accounts are available).
 *
 * Requires: Lil' JIT — JITO Bundles & Transactions add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @returns Jito bundle ID (UUID). Use getBundleStatusesFactory to poll status.
 *
 * @example
 * const sendJitoBundle = sendJitoBundleFactory(endpointUrl);
 * const bundleId = await sendJitoBundle([base64Tx1, base64Tx2]);
 * console.log(`Bundle submitted: ${bundleId}`);
 */
export const sendJitoBundleFactory = (endpointUrl: string) => {
  const sendJitoBundle = async (
    /** Array of base64-encoded, fully-signed transactions */
    serializedTransactions: string[]
  ): Promise<string> => {
    return rpcFetch<string>(endpointUrl, "sendBundle", [serializedTransactions]);
  };

  return sendJitoBundle;
};

/**
 * Creates a function that polls the status of submitted Jito bundles.
 *
 * Requires: Lil' JIT — JITO Bundles & Transactions add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getBundleStatuses = getBundleStatusesFactory(endpointUrl);
 * const statuses = await getBundleStatuses(["BUNDLE_ID"]);
 * console.log(statuses[0].status); // "Landed" | "Pending" | "Failed"
 */
export const getBundleStatusesFactory = (endpointUrl: string) => {
  const getBundleStatuses = async (
    bundleIds: string[]
  ): Promise<JitoBundleStatus[]> => {
    const result = await rpcFetch<{
      value: Array<{ bundle_id: string; confirmation_status: string; slot?: number }>;
    }>(endpointUrl, "getBundleStatuses", [bundleIds]);

    return (result.value ?? []).map((v) => ({
      bundleId: v.bundle_id,
      status: v.confirmation_status,
      landedSlot: v.slot,
    }));
  };

  return getBundleStatuses;
};

/**
 * Creates a function that sends a single signed transaction through Jito.
 *
 * Optionally sets `bundleOnly=true` on the endpoint URL so the request is
 * only submitted through the bundle pipeline.
 */
export const sendJitoTransactionFactory = (endpointUrl: string) => {
  const sendJitoTransaction = async (
    serializedTransaction: string,
    options: { bundleOnly?: boolean } = {}
  ): Promise<string> => {
    const url = options.bundleOnly
      ? `${stripTrailingSlash(endpointUrl)}?bundleOnly=true`
      : endpointUrl;

    return rpcFetch<string>(url, "sendTransaction", [serializedTransaction]);
  };

  return sendJitoTransaction;
};

/**
 * Creates a function that fetches inflight statuses for submitted Jito bundles.
 */
export const getInflightBundleStatusesFactory = (endpointUrl: string) => {
  const getInflightBundleStatuses = async (
    bundleIds: string[],
    options: { region?: string } = {}
  ): Promise<JitoInflightBundleStatus[]> => {
    const params: unknown[] = [bundleIds];
    if (options.region) params.push(options.region);

    const result = await rpcFetch<{
      value: Array<{ bundle_id: string; status: string; landed_slot?: number }>;
    }>(endpointUrl, "getInflightBundleStatuses", params);

    return (result.value ?? []).map((item) => ({
      bundleId: item.bundle_id,
      status: item.status,
      landedSlot: item.landed_slot,
    }));
  };

  return getInflightBundleStatuses;
};

/**
 * Creates a function that fetches Jito tip accounts.
 */
export const getJitoTipAccountsFactory = (endpointUrl: string) => {
  const getJitoTipAccounts = async (options: { region?: string } = {}): Promise<string[]> => {
    const params = options.region ? [options.region] : [];
    return rpcFetch<string[]>(endpointUrl, "getTipAccounts", params);
  };

  return getJitoTipAccounts;
};

/**
 * Creates a function that fetches recent Jito tip floor percentiles.
 */
export const getJitoTipFloorFactory = (endpointUrl: string) => {
  const getJitoTipFloor = async (): Promise<JitoTipFloor[]> => {
    const result = await rpcFetch<Array<{
      time: string;
      landed_tips_25th_percentile: number;
      landed_tips_50th_percentile: number;
      landed_tips_75th_percentile: number;
      landed_tips_95th_percentile: number;
      landed_tips_99th_percentile: number;
      ema_landed_tips_50th_percentile: number;
    }>>(endpointUrl, "getTipFloor", []);

    return result.map((item) => ({
      time: item.time,
      landedTips25thPercentile: item.landed_tips_25th_percentile,
      landedTips50thPercentile: item.landed_tips_50th_percentile,
      landedTips75thPercentile: item.landed_tips_75th_percentile,
      landedTips95thPercentile: item.landed_tips_95th_percentile,
      landedTips99thPercentile: item.landed_tips_99th_percentile,
      emaLandedTips50thPercentile: item.ema_landed_tips_50th_percentile,
    }));
  };

  return getJitoTipFloor;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  SOLANA MEV PROTECTION & RECOVERY — MERKLE
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface MevTxOptions {
  /** Base64-encoded fully-signed transaction */
  serializedTransaction: string;
  /** Optional tip in lamports to boost inclusion probability */
  tipLamports?: number;
}

/**
 * Creates a function that sends a transaction through Merkle's MEV-protected
 * validator network for guaranteed best inclusion and ordering.
 *
 * The transaction must already be signed and serialized to base64.
 * Returns the transaction signature on success.
 *
 * Requires: Solana MEV Protection & Recovery (by Merkle) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const sendMerkleTransaction = sendMerkleTransactionFactory(endpointUrl);
 * const signature = await sendMerkleTransaction({
 *   serializedTransaction: base64SignedTx,
 *   tipLamports: 10_000,
 * });
 * console.log(`Sent via Merkle MEV protection: ${signature}`);
 */
export const sendMerkleTransactionFactory = (endpointUrl: string) => {
  const sendMerkleTransaction = async (
    options: MevTxOptions
  ): Promise<string> => {
    return rpcFetch<string>(
      endpointUrl,
      "sendTransaction",
      buildProtectedSendTransactionParams(options)
    );
  };

  return sendMerkleTransaction;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  SOLANA MEV RESILIENCE & RECOVERY — BLINK LABS
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

/**
 * Creates a function that routes a transaction through Blink Labs' optimized
 * pipeline for improved inclusion rates and MEV resilience.
 *
 * The transaction must already be signed and serialized to base64.
 * Returns the transaction signature on success.
 *
 * Requires: Solana MEV Resilience & Recovery (by Blink Labs) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const sendBlinkLabsTransaction = sendBlinkLabsTransactionFactory(endpointUrl);
 * const signature = await sendBlinkLabsTransaction({
 *   serializedTransaction: base64SignedTx,
 * });
 * console.log(`Sent via Blink Labs: ${signature}`);
 */
export const sendBlinkLabsTransactionFactory = (endpointUrl: string) => {
  const sendBlinkLabsTransaction = async (
    options: MevTxOptions
  ): Promise<string> => {
    return rpcFetch<string>(
      endpointUrl,
      "sendTransaction",
      buildProtectedSendTransactionParams(options)
    );
  };

  return sendBlinkLabsTransaction;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  IRIS TRANSACTION SENDER — ASTRALANE
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface IrisTxOptions {
  /** Base64-encoded fully-signed transaction */
  serializedTransaction: string;
  /** Skip preflight simulation. Default: false */
  skipPreflight?: boolean;
  /** Number of send retries. Default: 3 */
  maxRetries?: number;
}

export interface IrisTxResult {
  signature: string;
  /** Slot the transaction landed in (when available) */
  slot?: number;
}

/**
 * Creates a function that sends a transaction via Astralane's Iris network —
 * a lightning-fast transaction sender with p90 sub-slot latency, built for
 * high-frequency traders, bots, and institutional-grade performance.
 *
 * The transaction must already be signed and serialized to base64.
 *
 * Requires: Iris Transaction Sender (by Astralane) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const sendIrisTransaction = sendIrisTransactionFactory(endpointUrl);
 * const { signature, slot } = await sendIrisTransaction({
 *   serializedTransaction: base64SignedTx,
 *   maxRetries: 5,
 * });
 * console.log(`Landed in slot ${slot}: ${signature}`);
 */
export const sendIrisTransactionFactory = (endpointUrl: string) => {
  const sendIrisTransaction = async (
    options: IrisTxOptions
  ): Promise<IrisTxResult> => {
    return rpcFetch<IrisTxResult>(
      endpointUrl,
      "iris_sendTransaction",
      {
        transaction: options.serializedTransaction,
        skipPreflight: options.skipPreflight ?? false,
        maxRetries: options.maxRetries ?? 3,
      }
    );
  };

  return sendIrisTransaction;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  TITAN — DeFi SWAP META-AGGREGATION API
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface TitanSwapRoute {
  dex:       string;
  percent:   number;
  inAmount:  string;
  outAmount: string;
}

export interface TitanSwapQuote {
  inputMint:      string;
  outputMint:     string;
  /** Raw input amount */
  inAmount:       string;
  /** Raw output amount */
  outAmount:      string;
  /** Minimum output amount after slippage */
  minOutAmount:   string;
  priceImpactPct: string;
  routes:         TitanSwapRoute[];
  timestamp:      number;
}

export interface GetTitanSwapQuoteOptions {
  /** Input token mint address */
  inputMint: string;
  /** Output token mint address */
  outputMint: string;
  /** Raw input amount (smallest units, e.g. lamports for SOL) */
  amount: string;
  /** Slippage tolerance in basis points. Default: 50 (0.5%) */
  slippageBps?: number;
}

/**
 * Creates a function that fetches a real-time best-price swap quote
 * from Titan's DeFi meta-aggregation engine, which aggregates across
 * all Solana DEXes via WebSocket streaming.
 *
 * Requires: DeFi Swap Meta-Aggregation API (by Titan) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getTitanSwapQuote = getTitanSwapQuoteFactory(endpointUrl);
 * const quote = await getTitanSwapQuote({
 *   inputMint:  "So11111111111111111111111111111111111111112",
 *   outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
 *   amount:     "1000000000",   // 1 SOL in lamports
 * });
 * console.log(`Best route: ${quote.outAmount} out via ${quote.routes.length} DEXes`);
 */
export const getTitanSwapQuoteFactory = (endpointUrl: string) => {
  const getTitanSwapQuote = async (
    options: GetTitanSwapQuoteOptions
  ): Promise<TitanSwapQuote> => {
    const qs = new URLSearchParams({
      inputMint: options.inputMint,
      outputMint: options.outputMint,
      amount: options.amount,
      slippageBps: String(options.slippageBps ?? 50),
    });
    return restGet<TitanSwapQuote>(
      `${stripTrailingSlash(endpointUrl)}/titan/v1/quote?${qs}`
    );
  };

  return getTitanSwapQuote;
};

/**
 * Creates a function that opens a WebSocket subscription to Titan's streaming
 * quote feed, receiving real-time best-price updates as market conditions change.
 *
 * Returns an unsubscribe function — call it to close the WebSocket.
 *
 * Requires: DeFi Swap Meta-Aggregation API (by Titan) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const subscribeTitanQuotes = subscribeTitanQuotesFactory(endpointUrl);
 * const unsubscribe = subscribeTitanQuotes(
 *   {
 *     inputMint:  "So11111111111111111111111111111111111111112",
 *     outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
 *     amount:     "1000000000",
 *   },
 *   (quote) => console.log("New best price:", quote.outAmount),
 *   (err)   => console.error("Stream error:", err)
 * );
 *
 * // Later — stop receiving updates
 * unsubscribe();
 */
export const subscribeTitanQuotesFactory = (endpointUrl: string) => {
  const subscribeTitanQuotes = (
    options:  GetTitanSwapQuoteOptions,
    onQuote:  (quote: TitanSwapQuote) => void,
    onError?: (err: Error) => void
  ): (() => void) => {
    const wsUrl = stripTrailingSlash(endpointUrl)
      .replace(/^https?/, "wss" in globalThis ? "wss" : "ws") + "/titan/v1/stream";

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        inputMint: options.inputMint,
        outputMint: options.outputMint,
        amount: options.amount,
        slippageBps: options.slippageBps ?? 50,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const quote = JSON.parse(event.data as string) as TitanSwapQuote;
        onQuote(quote);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    ws.onerror = () => {
      onError?.(new Error("Titan WebSocket connection error"));
    };

    return () => ws.close();
  };

  return subscribeTitanQuotes;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  GOLDRUSH — MULTICHAIN DATA APIS (by Covalent)
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface GoldRushTokenBalance {
  contractAddress: string;
  name:            string;
  symbol:          string;
  decimals:        number;
  logo?:           string;
  balance:         string;
  usdBalance?:     string;
  isSpam?:         boolean;
}

export interface GoldRushBalancesResult {
  chain:     string;
  address:   string;
  updatedAt: string;
  items:     GoldRushTokenBalance[];
}

export interface GoldRushTransaction {
  blockSignedAt: string;
  txHash:        string;
  successful:    boolean;
  fromAddress:   string;
  toAddress?:    string;
  value:         string;
  feesPaid:      string;
  gasSpent:      string;
  gasPrice:      string;
}

export interface GetGoldRushBalancesOptions {
  walletAddress:  string;
  /**
   * Chain identifier. Default: "solana-mainnet"
   * Examples: "eth-mainnet", "matic-mainnet", "bsc-mainnet"
   */
  chain?:         string;
  /** Filter out known spam tokens. Default: false */
  noSpam?:        boolean;
  /** Quote currency for USD values. Default: "USD" */
  quoteCurrency?: string;
}

export interface GetGoldRushTransactionsOptions {
  walletAddress: string;
  /** Chain identifier. Default: "solana-mainnet" */
  chain?:        string;
  /** Transactions per page. Default: 25 */
  pageSize?:     number;
  /** Page number, 0-indexed. Default: 0 */
  pageNumber?:   number;
}

interface GoldRushBalancesApiResponse {
  data: {
    chain_name: string;
    address: string;
    updated_at: string;
    items: Array<{
      contract_address: string;
      contract_name?: string;
      contract_ticker_symbol?: string;
      contract_decimals?: number;
      logo_url?: string;
      balance: string;
      quote?: number;
      is_spam?: boolean;
    }>;
  };
}

interface GoldRushTransactionsApiResponse {
  data: {
    current_page: number;
    links: { next?: string; prev?: string };
    items: Array<{
      block_signed_at: string;
      tx_hash: string;
      successful: boolean;
      from_address: string;
      to_address?: string;
      value: string;
      fees_paid: string;
      gas_spent: string | number;
      gas_price: string | number;
    }>;
  };
}

/**
 * Creates a function that fetches all token and NFT balances for a wallet
 * across any of GoldRush's 100+ supported chains.
 *
 * Requires: GoldRush — Multichain Data APIs (by Covalent) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getGoldRushBalances = getGoldRushBalancesFactory(endpointUrl);
 *
 * // Solana balances (default)
 * const solBalances = await getGoldRushBalances({ walletAddress: "WALLET_ADDRESS" });
 *
 * // Ethereum balances
 * const ethBalances = await getGoldRushBalances({
 *   walletAddress: "0xYOUR_ETH_WALLET",
 *   chain: "eth-mainnet",
 *   noSpam: true,
 * });
 * console.log(ethBalances.items.map(t => `${t.symbol}: $${t.usdBalance}`));
 */
export const getGoldRushBalancesFactory = (endpointUrl: string) => {
  const getGoldRushBalances = async (
    options: GetGoldRushBalancesOptions
  ): Promise<GoldRushBalancesResult> => {
    const chain = options.chain ?? "solana-mainnet";
    const qs    = new URLSearchParams();
    if (options.noSpam        !== undefined) qs.set("no-spam",        String(options.noSpam));
    if (options.quoteCurrency)               qs.set("quote-currency", options.quoteCurrency);
    const query = qs.size ? `?${qs}` : "";

    const result = await restGet<GoldRushBalancesApiResponse>(
      `${stripTrailingSlash(endpointUrl)}/goldrush/v1/${chain}/address/${options.walletAddress}/balances_v2/${query}`
    );

    return {
      chain: result.data.chain_name,
      address: result.data.address,
      updatedAt: result.data.updated_at,
      items: (result.data.items ?? []).map((item) => ({
        contractAddress: item.contract_address,
        name: item.contract_name ?? "",
        symbol: item.contract_ticker_symbol ?? "",
        decimals: item.contract_decimals ?? 0,
        logo: item.logo_url,
        balance: item.balance,
        usdBalance: item.quote !== undefined ? String(item.quote) : undefined,
        isSpam: item.is_spam,
      })),
    };
  };

  return getGoldRushBalances;
};

/**
 * Creates a function that fetches the full transaction history for a wallet
 * across any of GoldRush's 100+ supported chains, with pagination support.
 *
 * Requires: GoldRush — Multichain Data APIs (by Covalent) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const getGoldRushTransactions = getGoldRushTransactionsFactory(endpointUrl);
 * const result = await getGoldRushTransactions({
 *   walletAddress: "WALLET_ADDRESS",
 *   pageSize: 50,
 * });
 * result.items.forEach(tx => console.log(tx.txHash, tx.successful));
 */
export const getGoldRushTransactionsFactory = (endpointUrl: string) => {
  const getGoldRushTransactions = async (
    options: GetGoldRushTransactionsOptions
  ): Promise<{ items: GoldRushTransaction[]; currentPage: number; links: { next?: string } }> => {
    const chain = options.chain ?? "solana-mainnet";
    const qs    = new URLSearchParams();
    if (options.pageSize   !== undefined) qs.set("page-size",   String(options.pageSize));
    if (options.pageNumber !== undefined) qs.set("page-number",  String(options.pageNumber));
    const query = qs.size ? `?${qs}` : "";

    const result = await restGet<GoldRushTransactionsApiResponse>(
      `${stripTrailingSlash(endpointUrl)}/goldrush/v1/${chain}/address/${options.walletAddress}/transactions_v3/${query}`
    );

    return {
      currentPage: result.data.current_page,
      links: result.data.links ?? {},
      items: (result.data.items ?? []).map((item) => ({
        blockSignedAt: item.block_signed_at,
        txHash: item.tx_hash,
        successful: item.successful,
        fromAddress: item.from_address,
        toAddress: item.to_address,
        value: item.value,
        feesPaid: String(item.fees_paid),
        gasSpent: String(item.gas_spent),
        gasPrice: String(item.gas_price),
      })),
    };
  };

  return getGoldRushTransactions;
};


// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
//  RISK ASSESSMENT API — SCORECHAIN
// ════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────

export interface RiskFlag {
  category:    string;
  description: string;
  severity:    "low" | "medium" | "high" | "critical";
}

export interface WalletRiskAssessment {
  address:    string;
  network:    string;
  /** Risk score from 0 (clean) to 100 (high risk) */
  riskScore:  number;
  riskLevel:  "low" | "medium" | "high" | "severe";
  amlStatus:  "clean" | "flagged" | "blocked";
  flags:      RiskFlag[];
  /** URL to the full Scorechain compliance report */
  reportUrl?: string;
  assessedAt: string;
}

export interface AssessWalletRiskOptions {
  /** Wallet address to assess */
  address: string;
  /**
   * Blockchain network identifier. Default: "solana"
   * Examples: "ethereum", "bitcoin", "polygon"
   */
  network?: string;
}

/**
 * Creates a function that runs AML/CFT compliance screening on any wallet
 * address using Scorechain's global risk assessment engine.
 *
 * Returns a risk score (0–100), risk level, AML status, and detailed flags
 * covering sanctions, darknet, exchange categories, and more.
 *
 * Requires: Risk Assessment API (by Scorechain) add-on
 * Enable at: https://dashboard.quicknode.com → your endpoint → Add-ons
 *
 * @example
 * const assessWalletRisk = assessWalletRiskFactory(endpointUrl);
 * const result = await assessWalletRisk({ address: "WALLET_ADDRESS" });
 * if (result.amlStatus !== "clean") {
 *   console.warn(`Wallet flagged: ${result.riskLevel} risk (score ${result.riskScore})`);
 *   result.flags.forEach(f => console.warn(`  [${f.severity}] ${f.category}: ${f.description}`));
 * }
 */
export const assessWalletRiskFactory = (endpointUrl: string) => {
  const assessWalletRisk = async (
    options: AssessWalletRiskOptions
  ): Promise<WalletRiskAssessment> => {
    const qs = new URLSearchParams({
      address: options.address,
      network: options.network ?? "solana",
    });
    return restGet<WalletRiskAssessment>(
      `${stripTrailingSlash(endpointUrl)}/scorechain/v1/risk?${qs}`
    );
  };

  return assessWalletRisk;
};
