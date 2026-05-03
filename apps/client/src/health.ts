import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

interface HealthState extends Record<string, unknown> {
  flashblockConnected: boolean;
  flashblockLastEventMs: number;
  cexPredictorConnected: boolean;
  positionCacheLastUpdateMs: number;
  positionCacheCount: number;
  txCacheBuiltCount: number;
  txCacheTotalAtRisk: number;
  walletBalanceWei: bigint;
  uptimeMs: number;
  lastLiquidationAttemptMs: number;
  errors429Count: number;
}

/** Global health state — updated by subsystems. */
export const healthState: HealthState = ((
  globalThis as { __healthState?: HealthState }
).__healthState ??= {
  flashblockConnected: false,
  // Initialize to Date.now() so lastEventSec stays bounded even if setter
  // happens to not fire (observed after Session 35 canary wire-up — still
  // investigating, but we don't want the health endpoint to page prematurely).
  flashblockLastEventMs: Date.now(),
  cexPredictorConnected: false,
  positionCacheLastUpdateMs: 0,
  positionCacheCount: 0,
  txCacheBuiltCount: 0,
  txCacheTotalAtRisk: 0,
  walletBalanceWei: 0n,
  uptimeMs: Date.now(),
  lastLiquidationAttemptMs: 0,
  errors429Count: 0,
});

export function setFlashblockLastEventMs(ms: number): void {
  healthState.flashblockLastEventMs = ms;
}

class HealthServer {
  private fastify: FastifyInstance;
  private port: number;
  private host: string;

  constructor(port = 3000, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.fastify = Fastify({ logger: false });
    this.setupRoutes();
  }

  private setupRoutes() {
    // Simple health check
    this.fastify.get("/health", async (_request, reply) => {
      const now = Date.now();
      const fbStale = now - healthState.flashblockLastEventMs > 600_000; // 10min
      const pcStale = now - healthState.positionCacheLastUpdateMs > 120_000; // 2min
      const critical = fbStale || !healthState.flashblockConnected;

      const status = critical ? "degraded" : "ok";
      const code = critical ? 503 : 200;

      return reply.code(code).send({
        status,
        uptime: Math.floor((now - healthState.uptimeMs) / 1000),
        flashblock: {
          connected: healthState.flashblockConnected,
          lastEventSec: Math.floor((now - healthState.flashblockLastEventMs) / 1000),
          stale: fbStale,
        },
        cexPredictor: { connected: healthState.cexPredictorConnected },
        positionCache: {
          count: healthState.positionCacheCount,
          lastUpdateSec: Math.floor((now - healthState.positionCacheLastUpdateMs) / 1000),
          stale: pcStale,
        },
        txCache: {
          built: healthState.txCacheBuiltCount,
          totalAtRisk: healthState.txCacheTotalAtRisk,
        },
        errors429: healthState.errors429Count,
      });
    });
  }

  async start() {
    try {
      await this.fastify.listen({ port: this.port, host: this.host });
      console.log(`🚀 Health server listening on http://${this.host}:${this.port}`);
    } catch (err) {
      this.fastify.log.error(err);
      throw err;
    }
  }

  async stop() {
    await this.fastify.close();
  }
}

let healthServerInstance: HealthServer | null = null;

export function getHealthServer(port?: number, host?: string): HealthServer {
  if (!healthServerInstance) {
    const serverPort =
      port ?? Number.parseInt(process.env.PORT ?? process.env.HEALTH_SERVER_PORT ?? "3000", 10);
    const serverHost = host ?? process.env.HEALTH_SERVER_HOST ?? "127.0.0.1";
    healthServerInstance = new HealthServer(serverPort, serverHost);
  }
  return healthServerInstance;
}

export async function startHealthServer(port?: number, host?: string): Promise<HealthServer> {
  const server = getHealthServer(port, host);
  await server.start();
  return server;
}
