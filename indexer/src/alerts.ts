import type { DecodedRegistryEvent } from "./decoder.js";

export type AlertSeverity = "critical" | "high";

export interface AlertContext {
  brandDomain?: string;
}

export interface AlertServiceOptions {
  discordUrl?: string;
  slackUrl?: string;
  telegramUrl?: string;
  telegramChatId?: string;
  contractId?: string;
  network?: string;
}

function getStellarExpertBase(network: string): string {
  const net = network === "mainnet" || network === "public" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}`;
}

/**
 * Dispatches real-time alert notifications to Discord, Slack, and/or Telegram webhooks
 * when critical recall (`BatchRecalled`) or administrative security flag (`UnitFlagged`)
 * events are committed to the blockchain.
 *
 * Webhook URLs are read from environment variables. All dispatch errors are logged
 * but never thrown, ensuring indexer event processing is never blocked by alert failures.
 */
export class AlertService {
  private readonly discordUrl: string | undefined;
  private readonly slackUrl: string | undefined;
  private readonly telegramUrl: string | undefined;
  private readonly telegramChatId: string | undefined;
  private readonly contractId: string;
  private readonly stellarExpertBase: string;

  constructor(options?: AlertServiceOptions) {
    this.discordUrl = options?.discordUrl ?? process.env.DISCORD_WEBHOOK_URL;
    this.slackUrl = options?.slackUrl ?? process.env.SLACK_WEBHOOK_URL;
    this.telegramUrl = options?.telegramUrl ?? process.env.TELEGRAM_WEBHOOK_URL;
    this.telegramChatId = options?.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
    this.contractId = options?.contractId ?? process.env.REGISTRY_CONTRACT_ID ?? "";
    const network = options?.network ?? process.env.STELLAR_NETWORK ?? "testnet";
    this.stellarExpertBase = getStellarExpertBase(network);
  }

  /** Returns true when at least one webhook destination is configured. */
  get configured(): boolean {
    return Boolean(this.discordUrl || this.slackUrl || this.telegramUrl);
  }

  /**
   * Dispatches an alert for the given event if it is a critical recall or flag.
   * Fire-and-forget: errors are caught and logged, never thrown.
   */
  async dispatchAlert(
    event: DecodedRegistryEvent,
    context?: AlertContext,
  ): Promise<void> {
    if (event.type === "batch_recalled") {
      await this.notifyBatchRecalled(event, context);
    } else if (event.type === "unit_flagged") {
      await this.notifyUnitFlagged(event, context);
    }
  }

  private buildBatchRecalledMessage(
    event: Extract<DecodedRegistryEvent, { type: "batch_recalled" }>,
    context?: AlertContext,
  ): string {
    const txUrl = `${this.stellarExpertBase}/tx/${event.txHash}`;
    const contractUrl = `${this.stellarExpertBase}/contract/${this.contractId}`;
    const brandDomain = context?.brandDomain ?? "Unknown";

    return [
      "🚨 **CRITICAL: Product Batch Recalled** 🚨",
      "",
      `**Severity:** Critical`,
      `**Contract ID:** \`${this.contractId}\``,
      `**Brand Domain:** ${brandDomain}`,
      `**Batch ID:** \`${event.batchId}\``,
      `**Reason Hash:** \`${event.reasonHash}\``,
      `**Ledger:** ${event.ledger}`,
      `**Timestamp:** ${event.createdAt}`,
      "",
      `[View Transaction →](${txUrl})`,
      `[View Contract →](${contractUrl})`,
    ].join("\n");
  }

  private buildUnitFlaggedMessage(
    event: Extract<DecodedRegistryEvent, { type: "unit_flagged" }>,
    context?: AlertContext,
  ): string {
    const txUrl = `${this.stellarExpertBase}/tx/${event.txHash}`;
    const contractUrl = `${this.stellarExpertBase}/contract/${this.contractId}`;
    const brandDomain = context?.brandDomain ?? "Unknown";

    return [
      "⚠️ **HIGH: Unit Flagged by Manufacturer** ⚠️",
      "",
      `**Severity:** High`,
      `**Contract ID:** \`${this.contractId}\``,
      `**Brand Domain:** ${brandDomain}`,
      `**Unit ID:** \`${event.unitId}\``,
      `**Reason Hash:** \`${event.reasonHash}\``,
      `**Ledger:** ${event.ledger}`,
      `**Timestamp:** ${event.createdAt}`,
      "",
      `[View Transaction →](${txUrl})`,
      `[View Contract →](${contractUrl})`,
    ].join("\n");
  }

  private async sendToDiscord(message: string): Promise<void> {
    if (!this.discordUrl) return;
    await fetch(this.discordUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  }

  private async sendToSlack(message: string): Promise<void> {
    if (!this.slackUrl) return;
    await fetch(this.slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  }

  private async sendToTelegram(message: string): Promise<void> {
    if (!this.telegramUrl) return;
    const body: Record<string, string> = {
      text: message,
      parse_mode: "Markdown",
    };
    if (this.telegramChatId) {
      body.chat_id = this.telegramChatId;
    }
    await fetch(this.telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async sendAll(message: string): Promise<void> {
    const results = await Promise.allSettled([
      this.sendToDiscord(message),
      this.sendToSlack(message),
      this.sendToTelegram(message),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        console.error("[alerts] webhook delivery failed:", r.reason);
      }
    }
  }

  private async notifyBatchRecalled(
    event: Extract<DecodedRegistryEvent, { type: "batch_recalled" }>,
    context?: AlertContext,
  ): Promise<void> {
    const message = this.buildBatchRecalledMessage(event, context);
    await this.sendAll(message);
  }

  private async notifyUnitFlagged(
    event: Extract<DecodedRegistryEvent, { type: "unit_flagged" }>,
    context?: AlertContext,
  ): Promise<void> {
    const message = this.buildUnitFlaggedMessage(event, context);
    await this.sendAll(message);
  }
}
