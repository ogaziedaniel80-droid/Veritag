import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectTorchCapability,
  filterVideoInputDevices,
  formatCameraError,
} from "../components/QrScanner.js";
import { sortTimelineEvents } from "../components/ProvenanceTimeline.js";
import {
  isScanMuted,
  playScanSuccessFeedback,
  setScanMuted,
  toggleScanMuted,
} from "../lib/feedback.js";
import { registerPasskeySmartWallet } from "../lib/passkey.js";
import {
  buildUnsignedRegistryTxXdr,
  getFileDownloadUrl,
  PUBLIC_CONFIG,
  signRegistryTxWithSecret,
  verifyProduct,
} from "../lib/stellar.js";
import type { UnitTimelineEvent } from "../lib/stellar.js";

// Mock next/navigation so QrScanner helpers can be imported without a Next.js runtime
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("@veritag/web verification & passkey wallet logic", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Offline test mode")),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves offline/demo verification states accurately across serial patterns", async () => {
    const brand = "GB7TAYRUZGE6TVT7NHP5SMIZRNQA6PLM423EYISAOAP3MKYIQMVYP2JO";
    const batch = "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b";

    const unclaimed = await verifyProduct(brand, batch, "CH-2026-000101");
    expect(unclaimed.status).toBe("AuthenticInactive");
    expect(unclaimed.authentic).toBe(true);

    const active = await verifyProduct(brand, batch, "CH-2026-ACTIVE-04");
    expect(active.status).toBe("AuthenticActive");
    expect(active.unit?.warrantyValid).toBe(true);

    const dup = await verifyProduct(brand, batch, "CH-2026-DUP-88");
    expect(dup.status).toBe("AlreadyClaimedWarning");
    expect(dup.suspiciousScanVolume).toBe(true);

    const recalled = await verifyProduct(brand, batch, "CH-2026-RECALL-19");
    expect(recalled.status).toBe("Recalled");

    const fake = await verifyProduct(brand, batch, "FAKE-000999");
    expect(fake.status).toBe("Unknown");
    expect(fake.authentic).toBe(false);
  });

  it("generates P-256 passkey wallet credentials and formats file download URLs", async () => {
    const cred = await registerPasskeySmartWallet("Test Consumer Passkey");
    expect(cred.publicKeyHex.length).toBe(130);
    expect(cred.publicKeyHex.startsWith("04")).toBe(true);
    expect(cred.stellarSmartAddress.startsWith("C")).toBe(true);
    expect(cred.stellarSmartAddress.length).toBe(56);

    const fileUrl = getFileDownloadUrl("a".repeat(64));
    expect(fileUrl).toContain("/v1/files/" + "a".repeat(64));

    const kp = Keypair.random();
    const unsignedXdr = buildUnsignedRegistryTxXdr({
      callerAddress: kp.publicKey(),
      method: "commit_batch",
    });
    const signedXdr = signRegistryTxWithSecret(unsignedXdr, kp.secret());
    const parsedTx = TransactionBuilder.fromXDR(signedXdr, PUBLIC_CONFIG.networkPassphrase);
    expect(parsedTx.signatures.length).toBe(1);

    const passkeyUnsignedXdr = buildUnsignedRegistryTxXdr({
      callerAddress: cred.stellarSmartAddress,
      method: "activate",
    });
    expect(passkeyUnsignedXdr.length).toBeGreaterThan(20);
  });
});

describe("@veritag/web provenance timeline ordering", () => {
  function makeEvent(
    id: string,
    type: string,
    createdAt: string,
    ledger: number,
    txHash?: string,
  ): UnitTimelineEvent {
    return {
      id,
      type,
      ledger,
      txHash: txHash ?? `tx-${id}`,
      finalized: true,
      createdAt,
      data: {},
    };
  }

  it("sorts timeline events chronologically by createdAt timestamp", () => {
    const events: UnitTimelineEvent[] = [
      makeEvent("e3", "unit_activated", "2026-03-01T10:00:00Z", 300),
      makeEvent("e1", "batch_committed", "2026-01-01T10:00:00Z", 100),
      makeEvent("e2", "unit_transferred", "2026-02-01T10:00:00Z", 200),
      makeEvent("e4", "claim_filed", "2026-04-01T10:00:00Z", 400),
    ];

    const sorted = sortTimelineEvents(events);
    expect(sorted.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("uses ledger as tiebreaker when timestamps are identical", () => {
    const events: UnitTimelineEvent[] = [
      makeEvent("e3", "unit_activated", "2026-01-01T10:00:00Z", 300),
      makeEvent("e1", "batch_committed", "2026-01-01T10:00:00Z", 100),
      makeEvent("e2", "unit_transferred", "2026-01-01T10:00:00Z", 200),
    ];

    const sorted = sortTimelineEvents(events);
    expect(sorted.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("does not mutate the original array", () => {
    const events: UnitTimelineEvent[] = [
      makeEvent("e2", "unit_activated", "2026-02-01T10:00:00Z", 200),
      makeEvent("e1", "batch_committed", "2026-01-01T10:00:00Z", 100),
    ];

    const originalOrder = events.map((e) => e.id);
    sortTimelineEvents(events);
    expect(events.map((e) => e.id)).toEqual(originalOrder);
  });
});

describe("@veritag/web scan feedback module", () => {
  let store: Record<string, string>;
  let vibrateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = {};
    vibrateMock = vi.fn();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, val: string) => {
          store[key] = val;
        }),
        removeItem: vi.fn((key: string) => {
          delete store[key];
        }),
      },
    });
    vi.stubGlobal("navigator", { vibrate: vibrateMock });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists and reads mute preference via localStorage", () => {
    expect(isScanMuted()).toBe(false);
    setScanMuted(true);
    expect(isScanMuted()).toBe(true);
    const next = toggleScanMuted();
    expect(next).toBe(false);
    expect(isScanMuted()).toBe(false);
  });

  it("plays 800 Hz sine chime and vibrates on successful scan", () => {
    const mockOscillator = {
      type: "",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    const mockGainNode = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const mockCtx = {
      currentTime: 0,
      state: "running",
      resume: vi.fn(),
      close: vi.fn(),
      createOscillator: vi.fn(() => mockOscillator),
      createGain: vi.fn(() => mockGainNode),
      destination: {},
    };
    const AudioContextMock = vi.fn(() => mockCtx);

    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, val: string) => {
          store[key] = val;
        }),
        removeItem: vi.fn((key: string) => {
          delete store[key];
        }),
      },
      AudioContext: AudioContextMock,
    });

    playScanSuccessFeedback();

    expect(vibrateMock).toHaveBeenCalledWith([50]);
    expect(AudioContextMock).toHaveBeenCalledTimes(1);
    expect(mockOscillator.type).toBe("sine");
    expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(800, 0);
    expect(mockOscillator.start).toHaveBeenCalledTimes(1);
    expect(mockOscillator.stop).toHaveBeenCalledWith(0.075);
  });

  it("skips audio when muted but still vibrates", () => {
    const AudioContextMock = vi.fn();

    setScanMuted(true);

    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, val: string) => {
          store[key] = val;
        }),
        removeItem: vi.fn((key: string) => {
          delete store[key];
        }),
      },
      AudioContext: AudioContextMock,
    });

    playScanSuccessFeedback();

    expect(vibrateMock).toHaveBeenCalledWith([50]);
    expect(AudioContextMock).not.toHaveBeenCalled();
  });

  it("handles missing AudioContext gracefully without throwing", () => {
    // Window is already stubbed in beforeEach without AudioContext
    expect(() => playScanSuccessFeedback()).not.toThrow();
    expect(vibrateMock).toHaveBeenCalledWith([50]);
  });
});

describe("@veritag/web QR scanner camera helpers", () => {
  it("filters video input devices from all media devices", () => {
    const devices = [
      { deviceId: "cam1", kind: "videoinput", label: "Back Camera", groupId: "g1" },
      { deviceId: "mic1", kind: "audioinput", label: "Microphone", groupId: "g2" },
      { deviceId: "cam2", kind: "videoinput", label: "Front Camera", groupId: "g3" },
      { deviceId: "spk1", kind: "audiooutput", label: "Speaker", groupId: "g4" },
    ] as MediaDeviceInfo[];

    const result = filterVideoInputDevices(devices);
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.deviceId)).toEqual(["cam1", "cam2"]);
  });

  it("detects torch capability from track capabilities", () => {
    const trackWithTorch = {
      getCapabilities: () => ({ torch: true }),
    } as unknown as MediaStreamTrack;
    expect(detectTorchCapability(trackWithTorch)).toBe(true);

    const trackWithoutTorch = {
      getCapabilities: () => ({ torch: false }),
    } as unknown as MediaStreamTrack;
    expect(detectTorchCapability(trackWithoutTorch)).toBe(false);

    expect(detectTorchCapability(undefined)).toBe(false);
  });

  it("formats user-friendly camera error messages for permission denials and other failures", () => {
    expect(
      formatCameraError(new DOMException("denied", "NotAllowedError")),
    ).toContain("permission denied");
    expect(
      formatCameraError(new DOMException("not found", "NotFoundError")),
    ).toContain("No camera found");
    expect(
      formatCameraError(new DOMException("busy", "NotReadableError")),
    ).toContain("in use");
    expect(
      formatCameraError(new DOMException("constraint", "OverconstrainedError")),
    ).toContain("not available");
    expect(formatCameraError(new Error("generic failure"))).toContain(
      "Unable to access camera",
    );
  });
});
