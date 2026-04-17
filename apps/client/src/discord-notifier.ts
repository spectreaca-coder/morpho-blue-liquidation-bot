/**
 * Discord Notifier — sends liquidation alerts, daily summaries, and error reports
 * via Discord webhook. Zero dependencies (uses native fetch).
 */

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

interface LiquidationResult {
  market: string;
  borrower: string;
  seizedUsd: number;
  profitUsd: number;
  txHash: string;
  gasCost: number;
  walletIndex: number;
}

interface DailyStats {
  liquidations: number;
  totalProfit: number;
  monthlyProfit: number;
  walletBalances: { index: number; ethBalance: string; usdcBalance: string }[];
  positionsWatched: { base: number; eth: number };
  closestPosition?: { market: string; hf: number; borrowUsd: number };
}

export class DiscordNotifier {
  private cumulativeProfit = 0;
  private monthlyProfit = 0;
  private liquidationCount = 0;
  private revertCount = 0;
  private lastMonthReset = new Date().getMonth();

  private async send(content: string): Promise<void> {
    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Silent fail — don't let Discord errors affect bot operation
    }
  }

  /** Bot startup notification */
  async notifyStartup(version: string, walletCount: number, chains: string[]): Promise<void> {
    await this.send(
      `🟢 **Bot Started — ${version}**\n` +
        `> Wallets: ${walletCount}\n` +
        `> Chains: ${chains.join(", ")}\n` +
        `> Time: ${new Date().toISOString()}`,
    );
  }

  /** Successful liquidation */
  async notifyLiquidation(result: LiquidationResult): Promise<void> {
    this.liquidationCount++;
    this.cumulativeProfit += result.profitUsd;
    this.monthlyProfit += result.profitUsd;

    await this.send(
      `🔥 **청산 성공!**\n` +
        `> Market: **${result.market}**\n` +
        `> Profit: **$${result.profitUsd.toFixed(2)}**\n` +
        `> Seized: $${result.seizedUsd.toFixed(2)}\n` +
        `> Gas: $${result.gasCost.toFixed(4)}\n` +
        `> Wallet: #${result.walletIndex}\n` +
        `> TX: \`${result.txHash}\`\n` +
        `───────────────\n` +
        `> 📊 누적: **$${this.cumulativeProfit.toFixed(2)}** (${this.liquidationCount}건)\n` +
        `> 📅 이번 달: **$${this.monthlyProfit.toFixed(2)}**`,
    );
  }

  /** Optimistic TX fired (result unknown — may revert on-chain) */
  async notifyTxFired(
    market: string,
    borrower: string,
    txHash: string,
    walletIndex: number,
  ): Promise<void> {
    await this.send(
      `⚡ **TX 발사!**\n` +
        `> Market: **${market}**\n` +
        `> Borrower: \`${borrower.slice(0, 10)}...\`\n` +
        `> Wallet: #${walletIndex}\n` +
        `> TX: \`${txHash}\``,
    );
  }

  /** Revert (normal — position was healthy) */
  async notifyRevert(market: string, reason: string): Promise<void> {
    this.revertCount++;
    // Only notify every 10th revert to avoid spam
    if (this.revertCount % 10 === 1) {
      await this.send(
        `❌ Revert #${this.revertCount}: ${market}\n` +
          `> ${reason.slice(0, 100)}\n` +
          `> Cost: ~$0.01`,
      );
    }
  }

  /** Flash crash detected */
  async notifyFlashCrash(
    dropPercent: number,
    targetCount: number,
    aggregator: string,
  ): Promise<void> {
    await this.send(
      `🚨 **Flash Crash 감지!**\n` +
        `> 하락: **-${dropPercent.toFixed(1)}%**\n` +
        `> 타겟: **${targetCount}개** 포지션\n` +
        `> Oracle: ${aggregator}\n` +
        `> 배치 fire 중...`,
    );
  }

  /** Batch fire result */
  async notifyBatchResult(sent: number, failed: number, market: string): Promise<void> {
    await this.send(`⚡ **배치 결과**: ${market}\n` + `> 전송: ${sent}건, 실패: ${failed}건`);
  }

  /** Auto-refuel executed */
  async notifyRefuel(walletIndex: number, ethAmount: string): Promise<void> {
    await this.send(`⛽ Auto-Refuel: Wallet #${walletIndex}\n` + `> USDC → ${ethAmount} ETH 충전`);
  }

  /** Daily summary */
  async notifyDailySummary(stats: DailyStats): Promise<void> {
    // Reset monthly counter on month change
    const currentMonth = new Date().getMonth();
    if (currentMonth !== this.lastMonthReset) {
      this.monthlyProfit = 0;
      this.lastMonthReset = currentMonth;
    }

    const walletLines = stats.walletBalances
      .map((w) => `> W${w.index}: ${w.ethBalance} ETH, ${w.usdcBalance} USDC`)
      .join("\n");

    const closest = stats.closestPosition
      ? `> ⚠️ 가장 위험: ${stats.closestPosition.market} HF=${stats.closestPosition.hf.toFixed(4)} ($${stats.closestPosition.borrowUsd.toFixed(0)})`
      : "> ✅ 안전 (HF > 1.05 전부)";

    await this.send(
      `📊 **일일 리포트** (${new Date().toLocaleDateString("ko-KR")})\n` +
        `───────────────\n` +
        `> 오늘 청산: ${stats.liquidations}건, $${stats.totalProfit.toFixed(2)}\n` +
        `> 이번 달 누적: **$${this.monthlyProfit.toFixed(2)}**\n` +
        `> 전체 누적: **$${this.cumulativeProfit.toFixed(2)}** (${this.liquidationCount}건)\n` +
        `> Revert: ${this.revertCount}건 ($${(this.revertCount * 0.01).toFixed(2)})\n` +
        `───────────────\n` +
        `> 감시: Base ${stats.positionsWatched.base}개, ETH ${stats.positionsWatched.eth}개\n` +
        `${closest}\n` +
        `───────────────\n` +
        walletLines,
    );
  }

  /** Error alert (WS disconnect, critical failures) */
  async notifyError(component: string, error: string): Promise<void> {
    await this.send(`⚠️ **에러**: ${component}\n` + `> ${error.slice(0, 200)}`);
  }
}

/** Singleton instance */
export const discord = new DiscordNotifier();
