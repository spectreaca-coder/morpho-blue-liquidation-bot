import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from "viem";
import { base } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(repoRoot, ".env") });
dotenv.config();

const CHAIN_ID = 8453;
const MORPHO_BLUE_ADDRESS = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const LIQUIDATE_TOPIC0 = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41";
const MORPHO_API_URL = "https://blue-api.morpho.org/graphql";
// Base L2 block time = 2 s (flashblocks are 200ms sub-blocks but only full blocks count).
// 86_400 s / 2 s per block = 43_200 blocks per day. Previous 172_800n (0.5 s/block) caused
// --days N to scan ~4N days of events — confirmed by verify run 2026-04-17 (48h=6 events,
// --days 2 returned 18 events = 8 days).
const BLOCKS_PER_DAY_ESTIMATE = 43_200n;
const DEFAULT_CHUNK_SIZE = 10_000n;
const DEFAULT_CONCURRENCY = 8;
const MAX_LOG_RETRIES = 3;
const PROGRESS_INTERVAL = 100_000n;

const LIQUIDATE_ABI = parseAbi([
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
]);

const KNOWN_EXECUTOR_FALLBACKS = [
  "0x1489f3cde2892960d7cf2488182fb832394e3533",
  "0xb961d4e93391f8eda5394fb0b9d200bbdee1740a",
  "0x0bb46b54e2c470a4c7f63acdbca9a5316f962759",
];

function printHelp() {
  console.log(`Usage: node scripts/tip-analysis/mine-historical.mjs [options]

Options:
  --days N           Lookback window in days (default: 30)
  --out PATH         Output JSON path (default: analysis_output/competitor_analysis/historical_mined_YYYYMMDD.json)
  --chunk-size N     Blocks per eth_getLogs call (default: 10000)
  --concurrency N    Parallel tx receipt/tx fetches (default: 8)
  --help             Show this help and exit
`);
}

function parseCli(argv) {
  const nowStamp = formatDateYYYYMMDD(new Date());
  const defaults = {
    days: 30,
    chunkSize: DEFAULT_CHUNK_SIZE,
    concurrency: DEFAULT_CONCURRENCY,
    outPath: path.resolve(
      repoRoot,
      `analysis_output/competitor_analysis/historical_mined_${nowStamp}.json`,
    ),
  };

  const options = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--days") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value after --days");
      options.days = parsePositiveInteger(value, "--days");
      i += 1;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value after --out");
      options.outPath = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (arg === "--chunk-size") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value after --chunk-size");
      options.chunkSize = BigInt(parsePositiveInteger(value, "--chunk-size"));
      i += 1;
      continue;
    }
    if (arg === "--concurrency") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value after --concurrency");
      options.concurrency = parsePositiveInteger(value, "--concurrency");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }
  return parsed;
}

function formatDateYYYYMMDD(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function bigintMin(a, b) {
  return a < b ? a : b;
}

function toLowerAddressSet(values) {
  return new Set(values.map((value) => value.toLowerCase()));
}

function collectExecutorAddressesFromEnv() {
  const envExecutors = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("EXECUTOR_ADDRESS_")) continue;
    if (!value) continue;
    const trimmed = value.trim();
    if (!isAddress(trimmed)) continue;
    envExecutors.push(getAddress(trimmed).toLowerCase());
  }
  return toLowerAddressSet([...KNOWN_EXECUTOR_FALLBACKS, ...envExecutors]);
}

function buildClient(rpcUrl) {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, {
      timeout: 30_000,
      retryCount: 0,
    }),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function shouldShrinkLogWindow(error) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate") ||
    message.includes("too many requests") ||
    message.includes("range too wide") ||
    message.includes("block range") ||
    message.includes("response size exceeded") ||
    message.includes("query returned more than")
  );
}

function getProviderSuggestedChunkSize(error) {
  const detailText = [
    getErrorMessage(error),
    error?.details,
    ...(Array.isArray(error?.metaMessages) ? error.metaMessages : []),
  ]
    .filter(Boolean)
    .join(" ");
  const match = detailText.match(/work:\s*\[(0x[a-f0-9]+),\s*(0x[a-f0-9]+)\]/i);
  if (!match) return null;
  const fromHex = match[1];
  const toHex = match[2];
  return BigInt(toHex) - BigInt(fromHex) + 1n;
}

async function getLogsAdaptive(client, fromBlock, toBlock, startingChunkSize) {
  let chunkSize = startingChunkSize;
  let attempt = 0;
  let lastError;

  while (attempt < MAX_LOG_RETRIES) {
    try {
      return {
        chunkSizeUsed: chunkSize,
        logs: await client.getLogs({
          address: MORPHO_BLUE_ADDRESS,
          fromBlock,
          toBlock,
          event: LIQUIDATE_ABI[0],
        }),
      };
    } catch (error) {
      lastError = error;
      if (!shouldShrinkLogWindow(error) || chunkSize <= 1n) {
        throw error;
      }
      attempt += 1;
      if (attempt >= MAX_LOG_RETRIES) break;
      const providerSuggested = getProviderSuggestedChunkSize(error);
      chunkSize = chunkSize / 2n;
      if (providerSuggested && providerSuggested < chunkSize) {
        chunkSize = providerSuggested;
      }
      if (chunkSize < 1n) chunkSize = 1n;
      console.error(
        `[mine] shrinking chunk after getLogs failure for ${fromBlock}-${toBlock}: retry ${attempt}/${MAX_LOG_RETRIES}, new chunk-size ${chunkSize}`,
      );
      await sleep(500 * attempt);
    }
  }

  throw lastError;
}

async function scanLiquidationLogs(client, fromBlock, toBlock, initialChunkSize) {
  const allLogs = [];
  let currentBlock = fromBlock;
  let currentChunkSize = initialChunkSize;
  let nextProgressBoundary = fromBlock + PROGRESS_INTERVAL;

  while (currentBlock <= toBlock) {
    const endBlock = bigintMin(currentBlock + currentChunkSize - 1n, toBlock);
    const { logs, chunkSizeUsed } = await getLogsAdaptive(client, currentBlock, endBlock, currentChunkSize);
    allLogs.push(...logs);
    currentChunkSize = chunkSizeUsed;
    currentBlock = endBlock + 1n;

    while (currentBlock > nextProgressBoundary && nextProgressBoundary <= toBlock) {
      const completedBlocks = nextProgressBoundary - fromBlock;
      const totalBlocks = toBlock - fromBlock + 1n;
      const percent = Number((completedBlocks * 10_000n) / totalBlocks) / 100;
      console.error(
        `[mine] block ${nextProgressBoundary}/${toBlock} (${percent.toFixed(2)}% done), ${allLogs.length} logs so far`,
      );
      nextProgressBoundary += PROGRESS_INTERVAL;
    }
  }

  return allLogs;
}

async function getBlockCached(client, blockCache, blockNumber) {
  const key = blockNumber.toString();
  if (!blockCache.has(key)) {
    blockCache.set(
      key,
      client.getBlock({
        blockNumber,
      }),
    );
  }
  return blockCache.get(key);
}

async function getCodeCached(client, codeCache, address) {
  const key = address.toLowerCase();
  if (!codeCache.has(key)) {
    codeCache.set(key, client.getCode({ address: getAddress(address) }));
  }
  return codeCache.get(key);
}

function parseSelector(input) {
  if (!input || input === "0x" || input.length < 10) return null;
  return input.slice(0, 10).toLowerCase();
}

async function classifyToAddress(client, codeCache, executorAddresses, toAddress, txInput) {
  if (!toAddress) return "unknown_private_relay";

  const normalizedTo = toAddress.toLowerCase();
  if (normalizedTo === MORPHO_BLUE_ADDRESS.toLowerCase()) return "morpho_direct";
  if (executorAddresses.has(normalizedTo)) return "executor";

  const selector = parseSelector(txInput);
  if (selector === "0xbeefc0de" || selector === "0x0000beef" || selector === "0xbeefbeef") {
    return "unknown_private_relay";
  }
  if (selector?.startsWith("0xbeef")) {
    return "unknown_private_relay";
  }

  const code = await getCodeCached(client, codeCache, toAddress);
  if (!code || code === "0x") return "unknown_private_relay";
  return "unknown";
}

async function fetchMorphoMarketMetadata(marketIds) {
  const metadataByMarketId = new Map();
  if (marketIds.length === 0) return metadataByMarketId;

  const BATCH_SIZE = 200;
  const query = `
    query Markets($keys: [String!]) {
      markets(where: { uniqueKey_in: $keys }) {
        items {
          uniqueKey
          collateralAsset {
            symbol
          }
          loanAsset {
            symbol
          }
        }
      }
    }
  `;

  for (let i = 0; i < marketIds.length; i += BATCH_SIZE) {
    const batch = marketIds.slice(i, i + BATCH_SIZE);
    const response = await fetch(MORPHO_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-morpho-blue-liquidation-forensics/1.0",
      },
      body: JSON.stringify({
        query,
        variables: {
          keys: batch,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Morpho API request failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(`Morpho API error: ${JSON.stringify(json.errors[0])}`);
    }

    const items = json.data?.markets?.items ?? [];
    for (const item of items) {
      metadataByMarketId.set(item.uniqueKey, {
        collateralSymbol: item.collateralAsset?.symbol ?? null,
        loanSymbol: item.loanAsset?.symbol ?? null,
      });
    }
  }

  return metadataByMarketId;
}

function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function topEntries(countMap, limit) {
  return [...countMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function replacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  return value;
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function normalizeDecodedArgs(decoded) {
  return {
    marketId: decoded.args.id,
    winner: decoded.args.caller,
    borrower: decoded.args.borrower,
    repaidAssets: decoded.args.repaidAssets,
    repaidShares: decoded.args.repaidShares,
    seizedAssets: decoded.args.seizedAssets,
    badDebtAssets: decoded.args.badDebtAssets,
    badDebtShares: decoded.args.badDebtShares,
  };
}

async function pickLogClient(primaryUrl) {
  const candidates = [
    { label: "configured", url: primaryUrl },
    { label: "base-public", url: process.env.RPC_URL_8453 ?? base.rpcUrls.default.http[0] ?? "https://mainnet.base.org" },
  ];

  const seen = new Set();
  const uniqueCandidates = candidates.filter((candidate) => {
    if (!candidate.url || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });

  const latestClient = buildClient(primaryUrl);
  const latestBlock = await latestClient.getBlockNumber();
  const probeFrom = latestBlock > DEFAULT_CHUNK_SIZE ? latestBlock - DEFAULT_CHUNK_SIZE : 0n;

  for (const candidate of uniqueCandidates) {
    const client = buildClient(candidate.url);
    try {
      await client.getLogs({
        address: MORPHO_BLUE_ADDRESS,
        fromBlock: probeFrom,
        toBlock: latestBlock,
        event: LIQUIDATE_ABI[0],
      });
      if (candidate.label !== "configured") {
        console.error(
          `[mine] configured RPC has restrictive eth_getLogs policy; using fallback ${candidate.label} endpoint for log scan`,
        );
      }
      return { client, latestBlock, rpcUrlUsed: candidate.url };
    } catch (error) {
      const message = getErrorMessage(error);
      const providerSuggested = getProviderSuggestedChunkSize(error);
      const looksRestrictive = shouldShrinkLogWindow(error) && providerSuggested !== null;
      if (!looksRestrictive || candidate === uniqueCandidates[uniqueCandidates.length - 1]) {
        throw new Error(`Unable to initialize log client from ${candidate.label}: ${message}`);
      }
      console.error(
        `[mine] ${candidate.label} RPC rejected ${DEFAULT_CHUNK_SIZE}-block probe (${message.split("\n")[0]}). Trying fallback endpoint.`,
      );
    }
  }

  throw new Error("Unable to initialize a usable RPC client");
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(getErrorMessage(error));
    printHelp();
    process.exit(1);
  }

  const rpcUrl = process.env.BASE_ARCHIVE_RPC_URL ?? process.env.RPC_URL_8453;
  if (!rpcUrl) {
    console.error("Missing RPC URL. Set BASE_ARCHIVE_RPC_URL or RPC_URL_8453 in the environment.");
    process.exit(1);
  }

  const { client, latestBlock, rpcUrlUsed } = await pickLogClient(rpcUrl);
  const executorAddresses = collectExecutorAddressesFromEnv();
  const estimatedLookbackBlocks = BigInt(options.days) * BLOCKS_PER_DAY_ESTIMATE;
  const fromBlock = latestBlock > estimatedLookbackBlocks ? latestBlock - estimatedLookbackBlocks : 0n;
  const toBlock = latestBlock;

  console.error(
    `[mine] scanning Base Morpho Blue liquidations from block ${fromBlock} to ${toBlock} (${options.days} days) via ${rpcUrlUsed}`,
  );

  const rawLogs = await scanLiquidationLogs(client, fromBlock, toBlock, options.chunkSize);
  rawLogs.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return Number(a.blockNumber - b.blockNumber);
    return Number((a.logIndex ?? 0) - (b.logIndex ?? 0));
  });

  const decodedLogs = rawLogs.map((log) => {
    const decoded = decodeEventLog({
      abi: LIQUIDATE_ABI,
      data: log.data,
      topics: log.topics,
    });

    return {
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      ...normalizeDecodedArgs(decoded),
    };
  });

  const uniqueMarketIds = [...new Set(decodedLogs.map((log) => log.marketId))];
  const marketMetadata = await fetchMorphoMarketMetadata(uniqueMarketIds);
  const txHashes = [...new Set(decodedLogs.map((log) => log.transactionHash))];

  const blockCache = new Map();
  const codeCache = new Map();

  const txDataEntries = await mapLimit(txHashes, options.concurrency, async (hash, index) => {
    if (index > 0 && index % 250 === 0) {
      console.error(`[mine] fetched ${index}/${txHashes.length} tx+receipt pairs`);
    }

    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash }),
      client.getTransactionReceipt({ hash }),
    ]);
    const block = await getBlockCached(client, blockCache, receipt.blockNumber);
    const toAddressRole = await classifyToAddress(
      client,
      codeCache,
      executorAddresses,
      tx.to,
      tx.input,
    );

    return [
      hash,
      {
        tx,
        receipt,
        block,
        toAddressRole,
      },
    ];
  });

  const txDataByHash = new Map(txDataEntries);

  const rows = decodedLogs.map((log) => {
    const txData = txDataByHash.get(log.transactionHash);
    if (!txData) {
      throw new Error(`Missing tx data for ${log.transactionHash}`);
    }

    const effectiveGasPrice = txData.receipt.effectiveGasPrice ?? txData.tx.gasPrice ?? 0n;
    const baseFeePerGas = txData.block.baseFeePerGas ?? 0n;
    const tipWei = effectiveGasPrice > baseFeePerGas ? effectiveGasPrice - baseFeePerGas : 0n;
    const market = marketMetadata.get(log.marketId) ?? {
      collateralSymbol: null,
      loanSymbol: null,
    };

    return {
      blockNumber: Number(log.blockNumber),
      timestamp: new Date(Number(txData.block.timestamp) * 1000).toISOString(),
      txHash: log.transactionHash,
      winner: log.winner,
      borrower: log.borrower,
      marketId: log.marketId,
      collateralSymbol: market.collateralSymbol,
      loanSymbol: market.loanSymbol,
      repaidAssets: log.repaidAssets.toString(),
      seizedAssets: log.seizedAssets.toString(),
      repaidShares: log.repaidShares.toString(),
      badDebtAssets: log.badDebtAssets.toString(),
      tipWei: tipWei.toString(),
      tipGwei: Number(tipWei) / 1e9,
      effectiveGasPriceWei: effectiveGasPrice.toString(),
      baseFeePerGasWei: baseFeePerGas.toString(),
      gasUsed: txData.receipt.gasUsed.toString(),
      toAddress: txData.tx.to,
      toAddressRole: txData.toAddressRole,
      profitUsdHint: null,
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    days: options.days,
    count: rows.length,
    rows,
  };

  await ensureParentDir(options.outPath);
  await fs.writeFile(options.outPath, JSON.stringify(output, replacer, 2));

  const sortedTips = rows.map((row) => row.tipGwei).sort((a, b) => a - b);
  const winnerCounts = countBy(rows, (row) => row.winner.toLowerCase());
  const roleCounts = countBy(rows, (row) => row.toAddressRole);

  console.error(`[mine] wrote ${rows.length} rows to ${options.outPath}`);
  console.error(
    `[mine] tip gwei quantiles p25=${(quantile(sortedTips, 0.25) ?? 0).toFixed(6)} p50=${(quantile(sortedTips, 0.5) ?? 0).toFixed(6)} p75=${(quantile(sortedTips, 0.75) ?? 0).toFixed(6)} p99=${(quantile(sortedTips, 0.99) ?? 0).toFixed(6)}`,
  );
  console.error(
    `[mine] top-5 winners ${JSON.stringify(
      topEntries(winnerCounts, 5).map(([winner, count]) => ({ winner, count })),
    )}`,
  );
  console.error(
    `[mine] role breakdown ${JSON.stringify(
      Object.fromEntries([...roleCounts.entries()].sort((a, b) => b[1] - a[1])),
    )}`,
  );
}

await main();
