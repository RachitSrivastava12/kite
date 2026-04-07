// Based on smart-transaction.ts from https://github.com/mcintyre94/helius-smart-transactions-web3js2

import {
  Instruction,
  appendTransactionMessageInstruction,
  TransactionMessage,
  isWritableRole,
  isInstructionWithData,
  TransactionMessageWithFeePayer,
  createSolanaRpcFromTransport,
  sendAndConfirmTransactionFactory,
  TransactionWithBlockhashLifetime,
  FullySignedTransaction,
  Commitment,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  assertIsTransactionWithinSizeLimit,
  Transaction,
} from "@solana/kit";
import {
  getSetComputeUnitPriceInstruction,
  identifyComputeBudgetInstruction,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  estimateComputeUnitLimitFactory,
} from "@solana-program/compute-budget";
import { getAbortablePromise } from "@solana/promises";
import { DEFAULT_TRANSACTION_RETRIES, DEFAULT_TRANSACTION_TIMEOUT, SECONDS } from "./constants";

const getRecentPrioritizationFeeMedian = async (
  rpc: ReturnType<typeof createSolanaRpcFromTransport>,
  accountKeys: readonly string[],
  abortSignal: AbortSignal | null,
): Promise<number> => {
  const recentFeesResponse = await rpc.getRecentPrioritizationFees([...accountKeys]).send({ abortSignal });
  // @ts-expect-error TODO: typing error from original helius-smart-transactions-web3js2. Fix this.
  const recentFeesValues = recentFeesResponse.reduce((accumulator, current) => {
    if (current.prioritizationFee > 0n) {
      return [...accumulator, current.prioritizationFee];
    } else {
      return accumulator;
    }
  }, []);

  // @ts-expect-error TODO: typing error from original helius-smart-transactions-web3js2. Fix this.
  recentFeesValues.sort((a, b) => Number(a - b));
  return Number(recentFeesValues[Math.floor(recentFeesValues.length / 2)]);
};

const getQuicknodePriorityFeeEstimate = async (
  endpointUrl: string,
  accountKeys: readonly string[],
  abortSignal: AbortSignal | null,
): Promise<number> => {
  const params: Record<string, unknown> = {
    last_n_blocks: 100,
    api_version: 2,
  };

  if (accountKeys[0]) {
    params.account = accountKeys[0];
  }

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "qn_estimatePriorityFees",
      params,
    }),
    signal: abortSignal ?? undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Quicknode RPC error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text) as {
    result?: {
      recommended?: number;
      per_compute_unit?: { recommended?: number; medium?: number };
    };
    error?: { code: number; message: string };
  };

  if (data.error) {
    throw new Error(`Quicknode method error ${data.error.code}: ${data.error.message}`);
  }

  return (
    data.result?.recommended ??
    data.result?.per_compute_unit?.recommended ??
    data.result?.per_compute_unit?.medium ??
    0
  );
};

export const getPriorityFeeEstimate = async (
  rpc: ReturnType<typeof createSolanaRpcFromTransport>,
  supportsGetPriorityFeeEstimate: boolean,
  supportsQNEstimatePriorityFees: boolean,
  qnEndpointUrl: string | null,
  transactionMessage: TransactionMessage,
  abortSignal: AbortSignal | null = null,
): Promise<number> => {
  const accountKeys = [
    ...new Set([
      ...transactionMessage.instructions.flatMap((instruction: Instruction) =>
        (instruction.accounts ?? [])
          .filter((account) => isWritableRole(account.role))
          .map((account) => account.address),
      ),
    ]),
  ];

  if (supportsQNEstimatePriorityFees && qnEndpointUrl) {
    try {
      return await getQuicknodePriorityFeeEstimate(qnEndpointUrl, accountKeys, abortSignal);
    } catch {
      return getRecentPrioritizationFeeMedian(rpc, accountKeys, abortSignal);
    }
  }

  // If the RPC doesn't support getPriorityFeeEstimate, use the median of the recent fees
  if (!supportsGetPriorityFeeEstimate) {
    return getRecentPrioritizationFeeMedian(rpc, accountKeys, abortSignal);
  }
  // Get a priority fee estimate, using Helius' `getPriorityFeeEstimate` method on Helius mainnet

  const { priorityFeeEstimate } = await rpc
    .getPriorityFeeEstimate({
      accountKeys,
      options: {
        // See https://docs.helius.dev/solana-apis/priority-fee-api
        // Per Evan at Helius 20250213: recommended: true is not longer preferred,
        // instead use priorityLevel: "High"
        priorityLevel: "High",
      },
    })
    .send({ abortSignal });

  return priorityFeeEstimate;
};

export const getComputeUnitEstimate = async (
  rpc: ReturnType<typeof createSolanaRpcFromTransport>,
  transactionMessage: TransactionMessage & TransactionMessageWithFeePayer,
  abortSignal: AbortSignal | null = null,
) => {
  // add placeholder instruction for CU price if not already present
  // web3js estimate will add CU limit but not price
  // both take CUs, so we need both in the simulation
  const hasExistingComputeBudgetPriceInstruction = transactionMessage.instructions.some(
    (instruction) =>
      instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS &&
      isInstructionWithData(instruction) &&
      identifyComputeBudgetInstruction(instruction) === ComputeBudgetInstruction.SetComputeUnitPrice,
  );

  const transactionMessageToSimulate = hasExistingComputeBudgetPriceInstruction
    ? transactionMessage
    : appendTransactionMessageInstruction(getSetComputeUnitPriceInstruction({ microLamports: 0n }), transactionMessage);

  const estimateComputeUnitLimit = estimateComputeUnitLimitFactory({ rpc });
  // TODO: estimateComputeUnitLimit expects an explicit 'undefined' for abortSignal,
  // fix upstream
  return estimateComputeUnitLimit(transactionMessageToSimulate, {
    abortSignal: abortSignal ?? undefined,
  });
};

export const sendTransactionWithRetries = async (
  sendAndConfirmTransaction: ReturnType<typeof sendAndConfirmTransactionFactory>,
  transaction: Transaction & FullySignedTransaction & TransactionWithBlockhashLifetime,
  options: {
    maximumClientSideRetries: number;
    abortSignal: AbortSignal | null;
    commitment: Commitment;
    timeout?: number | null;
  } = {
    maximumClientSideRetries: DEFAULT_TRANSACTION_RETRIES,
    abortSignal: null,
    commitment: "confirmed",
    timeout: null,
  },
) => {
  if (options.commitment === "finalized") {
    console.warn(
      "Using finalized commitment for transaction with retries is not recommended. This will likely result in blockhash expiration.",
    );
  }

  let retriesLeft = options.maximumClientSideRetries;

  const transactionOptions = {
    // TODO: web3.js wants explicit undefineds. Fix upstream.
    abortSignal: options.abortSignal || undefined,
    commitment: options.commitment,
    // This is the server-side retries and should always be 0.
    // We will do retries here on the client.
    // See https://docs.helius.dev/solana-rpc-nodes/sending-transactions-on-solana#sending-transactions-without-the-sdk
    maxRetries: 0n,
  };

  let timeout: number;
  if (options.timeout) {
    timeout = options.timeout;
  } else {
    switch (options.commitment) {
      case "processed":
        timeout = 5 * SECONDS;
        break;
      case "confirmed":
        timeout = 15 * SECONDS;
        break;
      case "finalized":
        timeout = 30 * SECONDS;
        break;
      default:
        timeout = DEFAULT_TRANSACTION_TIMEOUT;
        break;
    }
  }

  while (retriesLeft) {
    try {
      assertIsTransactionWithinSizeLimit(transaction);
      const txPromise = sendAndConfirmTransaction(transaction, transactionOptions);
      await getAbortablePromise(txPromise, AbortSignal.timeout(timeout));
      break;
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        // timeout error happens if the transaction is not confirmed in DEFAULT_TRANSACTION_TIMEOUT
        // we can retry until we run out of retries
        console.debug("Transaction not confirmed, retrying...");
      } else if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) {
        // race condition where the transaction is processed between throwing the
        // `TimeoutError` and our next retry
        break;
      } else if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
        if (error.cause && isSolanaError(error.cause, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) {
          // race condition where the transaction is processed between throwing the
          // `TimeoutError` and our next retry and our simulation fails
          break;
        }
      } else {
        throw error;
      }
    } finally {
      retriesLeft--;
    }
  }
};
