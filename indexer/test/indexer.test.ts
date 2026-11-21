import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { sha256 } from "@veritag/sdk";
import type pg from "pg";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AlertService } from "../src/alerts.js";
import { decodeRegistryEvent, type RawSorobanEvent } from "../src/decoder.js";
import { parseCliArgs } from "../src/index.js";
import { IndexerPoller, type SorobanEventsProvider } from "../src/poller.js";
import { InMemoryIndexerWriter, PostgresIndexerWriter } from "../src/writer.js";

function scSym(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

function scAddr(pub: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(pub), { type: "address" });
}

function scBytes32(buf: Buffer): xdr.ScVal {
  return xdr.ScVal.scvBytes(buf);
}

function scMap(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(([k, val]) => new xdr.ScMapEntry({ key: scSym(k), val })),
  );
}

describe("@veritag/indexer XDR decoder, poller, and idempotent writer", () => {
  it("decodes base64 XDR Soroban contract events and projects full unit lifecycle idempotently", async () => {
    const brand = Keypair.random().publicKey();
    const serviceCenter = Keypair.random().publicKey();
    const alice = Keypair.random().publicKey();
    const bob = Keypair.random().publicKey();

    const batchId = sha256("BATCH-INDEXER-01");
    const root = sha256("MERKLE-ROOT-01");
    const unitId = sha256("UNIT-01");
    const reportHash = sha256("REPORT-01");
    const recallReason = sha256("RECALL-01");

    const rawEvents: RawSorobanEvent[] = [
      {
        id: "000100-1",
        ledger: 100,
        txHash: "tx1",
        topic: [scSym("brand_registered").toXDR("base64"), scAddr(brand).toXDR("base64")],
        value: scMap([["domain", xdr.ScVal.scvString("nordic-med.eu")]]).toXDR("base64"),
      },
      {
        id: "000101-1",
        ledger: 101,
        txHash: "tx2",
        topic: [scSym("brand_verified"), scAddr(brand)],
        value: scMap([]),
      },
      {
        id: "000102-1",
        ledger: 102,
        txHash: "tx3",
        topic: [scSym("batch_committed"), scAddr(brand), scBytes32(batchId)],
        value: scMap([
          ["root", scBytes32(root)],
          ["warranty_months", nativeToScVal(12, { type: "u32" })],
          ["unit_count", nativeToScVal(500n, { type: "u64" })],
        ]),
      },
      {
        id: "000103-1",
        ledger: 103,
        txHash: "tx4",
        topic: [scSym("unit_activated"), scBytes32(unitId)],
        value: scMap([
          ["brand", scAddr(brand)],
          ["batch_id", scBytes32(batchId)],
          ["owner", scAddr(alice)],
          ["warranty_expiry", nativeToScVal(1_800_000_000n, { type: "u64" })],
        ]),
      },
      {
        id: "000104-1",
        ledger: 104,
        txHash: "tx5",
        topic: [scSym("duplicate_attempt"), scBytes32(unitId)],
        value: scMap([["caller", scAddr(bob)]]),
      },
      {
        id: "000105-1",
        ledger: 105,
        txHash: "tx6",
        topic: [scSym("unit_transferred"), scBytes32(unitId)],
        value: scMap([
          ["from", scAddr(alice)],
          ["to", scAddr(bob)],
        ]),
      },
      {
        id: "000106-1",
        ledger: 106,
        txHash: "tx7",
        topic: [scSym("claim_filed"), scBytes32(unitId)],
        value: scMap([
          ["claim_id", nativeToScVal(1, { type: "u32" })],
          ["service_center", scAddr(serviceCenter)],
        ]),
      },
      {
        id: "000107-1",
        ledger: 107,
        txHash: "tx8",
        topic: [scSym("claim_resolved"), scBytes32(unitId)],
        value: scMap([
          ["claim_id", nativeToScVal(1, { type: "u32" })],
          ["outcome", nativeToScVal(3, { type: "u32" })], // Repaired = 3
          ["report_hash", scBytes32(reportHash)],
        ]),
      },
      {
        id: "000108-1",
        ledger: 108,
        txHash: "tx9",
        topic: [scSym("batch_recalled"), scAddr(brand), scBytes32(batchId)],
        value: scMap([["reason_hash", scBytes32(recallReason)]]),
      },
    ];

    // Quick sanity check on decoder directly
    const firstDecoded = decodeRegistryEvent(rawEvents[0]!);
    expect(firstDecoded?.type).toBe("brand_registered");

    const writer = new InMemoryIndexerWriter();
    let latestChainLedger = 108;
    let pollCalls = 0;

    const mockProvider: SorobanEventsProvider = {
      async fetchEvents(params) {
        pollCalls++;
        if (pollCalls === 1) {
          expect(params.cursor).toBeUndefined();
          return {
            latestLedger: latestChainLedger,
            cursor: "000108-1",
            events: rawEvents,
          };
        }
        // Second call replays last event + advances latestLedger to 112 so unconfirmed events finalize
        expect(params.cursor).toBe("000108-1");
        return {
          latestLedger: latestChainLedger,
          cursor: "000108-1",
          events: rawEvents.slice(-1),
        };
      },
    };

    const poller = new IndexerPoller({
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      provider: mockProvider,
      writer,
      confirmationLedgers: 2,
    });

    const cycle1 = await poller.pollOnce();
    expect(cycle1.fetched).toBe(9);
    expect(cycle1.applied).toBe(9);

    // Events at ledgers 107 and 108 are within 2 ledgers of 108, so not yet finalized
    expect(writer.events.get("000106-1")?.finalized).toBe(true);
    expect(writer.events.get("000107-1")?.finalized).toBe(false);
    expect(writer.events.get("000108-1")?.finalized).toBe(false);

    // Advance chain head & replay -> zero duplicate state mutations, all pending events finalized!
    latestChainLedger = 112;
    const cycle2 = await poller.pollOnce();
    expect(cycle2.fetched).toBe(1);
    expect(cycle2.applied).toBe(0);
    expect(cycle2.finalized).toBe(1);
    expect(writer.events.get("000107-1")?.finalized).toBe(true);
    expect(writer.events.get("000108-1")?.finalized).toBe(true);

    const unitHex = unitId.toString("hex");
    const projectedUnit = writer.units.get(unitHex)!;
    expect(projectedUnit.owner).toBe(bob);
    expect(projectedUnit.duplicateAttempts).toBe(1);
    expect(projectedUnit.claimsUsed).toBe(1);
    expect(projectedUnit.status).toBe("Recalled");

    const projectedClaim = writer.claims.get(`${unitHex}:1`)!;
    expect(projectedClaim.outcome).toBe("Repaired");
    expect(projectedClaim.reportHash).toBe(reportHash.toString("hex"));
  });

  it("backfills ledger ranges across pages and executes PostgresIndexerWriter SQL transactions", async () => {
    expect(parseCliArgs(["--backfill", "--from", "50", "--to", "150"])).toEqual({
      backfill: true,
      fromLedger: 50,
      toLedger: 150,
    });

    const brand = Keypair.random().publicKey();
    const rawPage1: RawSorobanEvent[] = [
      {
        id: "000050-1",
        ledger: 50,
        txHash: "tx50",
        topic: [scSym("brand_registered"), scAddr(brand)],
        value: scMap([["domain", xdr.ScVal.scvString("helvetia.ch")]]),
      },
    ];
    const rawPage2: RawSorobanEvent[] = [
      {
        id: "000080-1",
        ledger: 80,
        txHash: "tx80",
        topic: [scSym("brand_verified"), scAddr(brand)],
        value: scMap([]),
      },
    ];

    const seenIds = new Set<string>();
    const executedSql: string[] = [];

    const mockClient = {
      query: async (sql: string, params: unknown[] = []) => {
        executedSql.push(sql.trim());
        if (sql.includes("INSERT INTO unit_events")) {
          const evId = String(params[0]);
          if (seenIds.has(evId)) {
            return { rowCount: 0, rows: [] };
          }
          seenIds.add(evId);
          return { rowCount: 1, rows: [{ id: evId }] };
        }
        return { rowCount: 1, rows: [] };
      },
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
      query: async (sql: string) => {
        executedSql.push(sql.trim());
        return { rowCount: 0, rows: [] };
      },
      end: async () => {},
    } as unknown as pg.Pool;

    const pgWriter = new PostgresIndexerWriter(mockPool);
    let pageCall = 0;
    const provider: SorobanEventsProvider = {
      async fetchEvents() {
        pageCall++;
        if (pageCall === 1) {
          return { latestLedger: 120, cursor: "c1", events: rawPage1 };
        }
        return { latestLedger: 120, cursor: "c2", events: rawPage2 };
      },
    };

    const poller = new IndexerPoller({
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      provider,
      writer: pgWriter,
    });

    const summary = await poller.backfillRange(50, 80);
    expect(summary).toEqual({ pages: 2, fetched: 2, applied: 2 });
    expect(executedSql.some((s) => s.includes("INSERT INTO brands"))).toBe(true);
    expect(executedSql.some((s) => s.includes("UPDATE brands SET verified = TRUE"))).toBe(true);

    // Re-applying an already-seen event is idempotently ignored
    const duplicateDecoded = decodeRegistryEvent(rawPage1[0]!)!;
    const dupRes = await pgWriter.applyEvent(duplicateDecoded, true);
    expect(dupRes.applied).toBe(false);
  });
});

describe("@veritag/indexer AlertService webhook dispatcher", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches BatchRecalled alerts to Discord and Slack with formatted markdown", async () => {
    const discordUrl = "https://discord.example/webhook";
    const slackUrl = "https://slack.example/webhook";
    const contractId = "CCONTRACT123";

    const alerts = new AlertService({
      discordUrl,
      slackUrl,
      contractId,
      network: "testnet",
    });

    const event = {
      type: "batch_recalled" as const,
      id: "alert-recall-001",
      ledger: 500,
      txHash: "tx-recall-hash-001",
      createdAt: "2026-01-15T10:00:00Z",
      brand: "GBRANDADDRESS001",
      batchId: "batch-id-abc",
      reasonHash: "reason-hash-abc",
    };

    await alerts.dispatchAlert(event, { brandDomain: "nordic-med.eu" });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const discordCall = fetchMock.mock.calls[0]!;
    expect(discordCall[0]).toBe(discordUrl);
    const discordBody = JSON.parse(discordCall[1].body as string);
    expect(discordBody.content).toContain("Batch Recalled");
    expect(discordBody.content).toContain("nordic-med.eu");
    expect(discordBody.content).toContain("batch-id-abc");
    expect(discordBody.content).toContain("CCONTRACT123");
    expect(discordBody.content).toContain("stellar.expert/explorer/testnet/tx/tx-recall-hash-001");

    const slackCall = fetchMock.mock.calls[1]!;
    expect(slackCall[0]).toBe(slackUrl);
    const slackBody = JSON.parse(slackCall[1].body as string);
    expect(slackBody.text).toContain("Batch Recalled");
    expect(slackBody.text).toContain("nordic-med.eu");
  });

  it("dispatches UnitFlagged alerts with severity and contract ID", async () => {
    const alerts = new AlertService({
      discordUrl: "https://discord.example/webhook",
      contractId: "CCONTRACT456",
      network: "testnet",
    });

    const event = {
      type: "unit_flagged" as const,
      id: "alert-flag-001",
      ledger: 501,
      txHash: "tx-flag-hash-001",
      createdAt: "2026-01-15T11:00:00Z",
      unitId: "unit-id-xyz",
      reasonHash: "flag-reason-hash",
    };

    await alerts.dispatchAlert(event, { brandDomain: "helvetia.ch" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.content).toContain("Unit Flagged");
    expect(body.content).toContain("helvetia.ch");
    expect(body.content).toContain("unit-id-xyz");
    expect(body.content).toContain("CCONTRACT456");
    expect(body.content).toContain("stellar.expert/explorer/testnet/tx/tx-flag-hash-001");
  });

  it("handles webhook delivery failures gracefully without throwing", async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const alerts = new AlertService({
      discordUrl: "https://discord.example/webhook",
      slackUrl: "https://slack.example/webhook",
    });

    const event = {
      type: "batch_recalled" as const,
      id: "alert-fail-001",
      ledger: 600,
      txHash: "tx-fail-001",
      createdAt: "2026-01-15T12:00:00Z",
      brand: "GBRAND002",
      batchId: "batch-fail",
      reasonHash: "reason-fail",
    };

    // Should not throw
    await expect(alerts.dispatchAlert(event)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("InMemoryIndexerWriter dispatches alerts when processing BatchRecalled and UnitFlagged events", async () => {
    const brand = Keypair.random().publicKey();
    const batchId = sha256("ALERT-BATCH-01").toString("hex");
    const unitId = sha256("ALERT-UNIT-01").toString("hex");

    const alerts = new AlertService({
      discordUrl: "https://discord.example/webhook",
      slackUrl: "https://slack.example/webhook",
      contractId: "CCONTRACT789",
      network: "testnet",
    });

    const writer = new InMemoryIndexerWriter(alerts);

    // Register brand so the writer has domain context for alerts
    await writer.applyEvent(
      {
        type: "brand_registered",
        id: "brand-reg-01",
        ledger: 100,
        txHash: "tx-brand-reg",
        createdAt: "2026-01-10T08:00:00Z",
        brand,
        domain: "chronos-watches.swiss",
      },
      true,
    );

    await writer.applyEvent(
      {
        type: "batch_committed",
        id: "batch-com-01",
        ledger: 101,
        txHash: "tx-batch-com",
        createdAt: "2026-01-10T09:00:00Z",
        brand,
        batchId,
        root: sha256("ROOT").toString("hex"),
        warrantyMonths: 24,
        unitCount: 100,
      },
      true,
    );

    await writer.applyEvent(
      {
        type: "unit_activated",
        id: "unit-act-01",
        ledger: 102,
        txHash: "tx-unit-act",
        createdAt: "2026-01-10T10:00:00Z",
        unitId,
        brand,
        batchId,
        owner: Keypair.random().publicKey(),
        warrantyExpiry: 1_900_000_000,
      },
      true,
    );

    fetchMock.mockClear();

    // BatchRecalled → should trigger alert with brand domain
    await writer.applyEvent(
      {
        type: "batch_recalled",
        id: "batch-recall-01",
        ledger: 103,
        txHash: "tx-recall-final",
        createdAt: "2026-01-15T10:00:00Z",
        brand,
        batchId,
        reasonHash: "recall-reason-hash",
      },
      true,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recallBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(recallBody.content).toContain("chronos-watches.swiss");
    expect(recallBody.content).toContain("Batch Recalled");

    fetchMock.mockClear();

    // UnitFlagged → should trigger alert with brand domain looked up from unit
    await writer.applyEvent(
      {
        type: "unit_flagged",
        id: "unit-flag-01",
        ledger: 104,
        txHash: "tx-flag-final",
        createdAt: "2026-01-15T11:00:00Z",
        unitId,
        reasonHash: "flag-reason-hash",
      },
      true,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const flagBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(flagBody.content).toContain("Unit Flagged");
    expect(flagBody.content).toContain("chronos-watches.swiss");

    // Duplicate event should NOT re-trigger alert (idempotent)
    fetchMock.mockClear();
    await writer.applyEvent(
      {
        type: "batch_recalled",
        id: "batch-recall-01",
        ledger: 103,
        txHash: "tx-recall-final",
        createdAt: "2026-01-15T10:00:00Z",
        brand,
        batchId,
        reasonHash: "recall-reason-hash",
      },
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
