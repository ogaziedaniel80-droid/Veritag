"use client";

import { parseVerifyPath } from "@veritag/sdk";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  isScanMuted,
  playScanSuccessFeedback,
  toggleScanMuted,
} from "@/lib/feedback";

/** Filters a list of media devices to only video input (camera) devices. */
export function filterVideoInputDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter((d) => d.kind === "videoinput");
}

/** Detects whether a media stream track supports the torch (flashlight) capability. */
export function detectTorchCapability(track: MediaStreamTrack | undefined): boolean {
  if (!track || typeof track.getCapabilities !== "function") return false;
  const caps = track.getCapabilities();
  return Boolean((caps as unknown as { torch?: boolean }).torch);
}

/** Formats a user-friendly error message for camera access failures. */
export function formatCameraError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "Camera permission denied. Please allow camera access in your browser settings, then try again.";
      case "NotFoundError":
        return "No camera found on this device. Paste the QR URL or upload an SVG label instead.";
      case "NotReadableError":
        return "Camera is in use by another application. Close it and try again.";
      case "OverconstrainedError":
        return "Selected camera is not available. Try a different camera or use the default.";
      default:
        return `Camera error: ${err.message}. Try pasting the QR URL below.`;
    }
  }
  return "Unable to access camera. Try pasting the QR URL or uploading an SVG label.";
}

export function QrScanner() {
  const router = useRouter();
  const [pasteInput, setPasteInput] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(undefined);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setMuted(isScanMuted());
  }, []);

  function routeFromQrPayload(rawPayload: string): boolean {
    setScanError(null);
    const trimmed = rawPayload.trim();
    if (!trimmed) return false;

    try {
      const url = trimmed.startsWith("http")
        ? new URL(trimmed)
        : new URL(trimmed, "https://veritag.local");
      const parsed = parseVerifyPath(url.pathname);
      if (parsed) {
        const hashSuffix = url.hash ? url.hash : "";
        router.push(
          `/v/${encodeURIComponent(parsed.brand)}/${encodeURIComponent(parsed.batch)}/${encodeURIComponent(parsed.serial)}${hashSuffix}`,
        );
        return true;
      }
    } catch {
      // Fall through to error message
    }
    setScanError("QR payload does not match /v/:brand/:batch/:serial format");
    return false;
  }

  async function enumerateVideoDevices(): Promise<MediaDeviceInfo[]> {
    if (typeof window === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return filterVideoInputDevices(devices);
    } catch {
      return [];
    }
  }

  async function handleStartCamera(targetDeviceId?: string) {
    setScanError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setScanError("Camera access is not available in this browser.");
      return;
    }
    try {
      const constraints: MediaStreamConstraints = targetDeviceId
        ? { video: { deviceId: { exact: targetDeviceId } } }
        : { video: { facingMode: "environment" } };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setCameraActive(true);

      // Enumerate devices now that camera permission is granted (labels become available)
      const devices = await enumerateVideoDevices();
      setVideoDevices(devices);

      // Track the active device and detect torch capability
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        setSelectedDeviceId(settings.deviceId ?? targetDeviceId);
        setTorchSupported(detectTorchCapability(videoTrack));
      }
      setTorchOn(false);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const BarcodeDetectorCtor = (
        window as unknown as {
          BarcodeDetector?: new (opts: { formats: string[] }) => {
            detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
          };
        }
      ).BarcodeDetector;

      if (BarcodeDetectorCtor && videoRef.current) {
        const detector = new BarcodeDetectorCtor({ formats: ["qr_code"] });
        scanIntervalRef.current = setInterval(async () => {
          if (!videoRef.current || !streamRef.current) {
            if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
            return;
          }
          try {
            const codes = await detector.detect(videoRef.current);
            const firstVal = codes[0]?.rawValue;
            if (firstVal) {
              if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
              handleStopCamera();
              playScanSuccessFeedback();
              routeFromQrPayload(firstVal);
            }
          } catch {
            // Continue scanning frames
          }
        }, 400);
      }
    } catch (err) {
      setScanError(formatCameraError(err));
    }
  }

  function handleStopCamera() {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    setCameraActive(false);
    setTorchSupported(false);
    setTorchOn(false);
  }

  async function handleSwitchCamera(deviceId: string) {
    setSelectedDeviceId(deviceId);
    if (cameraActive) {
      handleStopCamera();
      await handleStartCamera(deviceId);
    }
  }

  async function handleToggleTorch() {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const newState = !torchOn;
      await track.applyConstraints({
        advanced: [{ torch: newState } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(newState);
    } catch {
      // Torch toggle failed — silently ignore
    }
  }

  function handleToggleMute() {
    const newMuted = toggleScanMuted();
    setMuted(newMuted);
  }

  async function handleSvgUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const match = text.match(/data-qr-payload="([^"]+)"/);
    if (match?.[1]) {
      const decoded = match[1]
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      playScanSuccessFeedback();
      routeFromQrPayload(decoded);
      return;
    }
    setScanError("Uploaded file did not contain a recognizable Veritag QR payload.");
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
          QR Tag Scanner (Camera, File, or URL)
        </span>
        <div className="flex items-center gap-2">
          {/* Mute / unmute audio feedback toggle */}
          <button
            type="button"
            onClick={handleToggleMute}
            title={muted ? "Unmute scan chime" : "Mute scan chime"}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            {muted ? "🔇" : "🔊"}
          </button>

          {!cameraActive ? (
            <button
              type="button"
              onClick={() => handleStartCamera()}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Open Camera Scanner
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStopCamera}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
            >
              Stop Camera
            </button>
          )}
        </div>
      </div>

      {cameraActive && (
        <>
          <video
            ref={videoRef}
            className="h-44 w-full rounded-lg bg-black object-cover"
            muted
            playsInline
          />

          <div className="flex flex-wrap items-center gap-2">
            {/* Camera selector dropdown — only shown when multiple cameras are available */}
            {videoDevices.length > 1 && (
              <select
                value={selectedDeviceId ?? ""}
                onChange={(e) => handleSwitchCamera(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 focus:border-blue-600 focus:outline-none"
                aria-label="Switch camera"
              >
                {videoDevices.map((device, idx) => (
                  <option key={device.deviceId ?? idx} value={device.deviceId ?? ""}>
                    {device.label || `Camera ${idx + 1}`}
                  </option>
                ))}
              </select>
            )}

            {/* Flashlight / torch toggle — only shown when the active track supports it */}
            {torchSupported && (
              <button
                type="button"
                onClick={handleToggleTorch}
                title={torchOn ? "Turn off flashlight" : "Turn on flashlight"}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                  torchOn
                    ? "border-amber-400 bg-amber-100 text-amber-900"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                {torchOn ? "🔦 On" : "🔦 Off"}
              </button>
            )}
          </div>
        </>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Paste QR URL (/v/G.../batch/serial#s=...)"
          value={pasteInput}
          onChange={(e) => setPasteInput(e.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => routeFromQrPayload(pasteInput)}
          className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100"
        >
          Parse QR
        </button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>Or inspect an exported Veritag SVG label:</span>
        <label className="cursor-pointer font-semibold text-blue-600 hover:underline">
          Upload QR SVG
          <input type="file" accept=".svg,image/svg+xml" onChange={handleSvgUpload} className="hidden" />
        </label>
      </div>

      {scanError && <p className="text-xs font-medium text-red-600">{scanError}</p>}
    </div>
  );
}
