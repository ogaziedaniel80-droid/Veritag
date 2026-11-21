const MUTE_KEY = "veritag_scan_muted";

/**
 * Returns whether the scan success audio chime is muted.
 * Reads from localStorage; returns false when unavailable (SSR, private browsing).
 */
export function isScanMuted(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(MUTE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Persists the scan audio mute preference to localStorage.
 */
export function setScanMuted(muted: boolean): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MUTE_KEY, String(muted));
  } catch {
    // localStorage not available (e.g., private browsing mode)
  }
}

/**
 * Toggles the mute preference and returns the new state.
 */
export function toggleScanMuted(): boolean {
  const next = !isScanMuted();
  setScanMuted(next);
  return next;
}

/**
 * Plays a short 800 Hz sine-wave audio chime (75 ms) via the Web Audio API
 * and triggers haptic vibration feedback. Requires zero audio file downloads.
 *
 * Audio is skipped when the user has muted the preference.
 * Handles browser autoplay restrictions by resuming a suspended AudioContext.
 * All errors are swallowed so scan flow is never blocked by feedback failures.
 */
export function playScanSuccessFeedback(): void {
  // Haptic vibration feedback
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate([50]);
    } catch {
      // Vibration not supported or permission denied
    }
  }

  // Audio chime — skip when muted
  if (isScanMuted()) return;

  try {
    const AudioContextCtor =
      typeof window !== "undefined"
        ? window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AudioContextCtor) return;

    const ctx = new AudioContextCtor();

    // Handle autoplay restrictions: resume if the context was created suspended
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(800, ctx.currentTime);

    // 75 ms beep with exponential fade-out to avoid audible click
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.075);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.075);

    // Clean up the AudioContext after the beep finishes
    oscillator.onended = () => {
      void ctx.close();
    };
  } catch {
    // Audio not supported or blocked by autoplay policy — fail silently
  }
}
