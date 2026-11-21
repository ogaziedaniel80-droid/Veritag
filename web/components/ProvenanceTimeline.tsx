"use client";

import type { UnitTimelineEvent } from "@/lib/stellar";
import { PUBLIC_CONFIG } from "@/lib/stellar";

interface EventMeta {
  icon: string;
  label: string;
  colorClass: string;
  dotClass: string;
}

const EVENT_META: Record<string, EventMeta> = {
  batch_committed: {
    icon: "📦",
    label: "Batch Committed by Brand",
    colorClass: "border-indigo-200 bg-indigo-50",
    dotClass: "bg-indigo-500",
  },
  unit_activated: {
    icon: "✅",
    label: "First Sale & Lazy Activation",
    colorClass: "border-emerald-200 bg-emerald-50",
    dotClass: "bg-emerald-500",
  },
  unit_transferred: {
    icon: "🔄",
    label: "Ownership Resale Transfer",
    colorClass: "border-blue-200 bg-blue-50",
    dotClass: "bg-blue-500",
  },
  transfer_offered: {
    icon: "📤",
    label: "Transfer Offered",
    colorClass: "border-cyan-200 bg-cyan-50",
    dotClass: "bg-cyan-500",
  },
  transfer_cancelled: {
    icon: "❌",
    label: "Transfer Cancelled",
    colorClass: "border-slate-200 bg-slate-50",
    dotClass: "bg-slate-400",
  },
  claim_filed: {
    icon: "🔧",
    label: "Warranty Service Claim Filed",
    colorClass: "border-amber-200 bg-amber-50",
    dotClass: "bg-amber-500",
  },
  claim_resolved: {
    icon: "🛠️",
    label: "Service Claim Resolved",
    colorClass: "border-teal-200 bg-teal-50",
    dotClass: "bg-teal-500",
  },
  unit_flagged: {
    icon: "⚠️",
    label: "Unit Flagged",
    colorClass: "border-red-200 bg-red-50",
    dotClass: "bg-red-500",
  },
  batch_recalled: {
    icon: "🚨",
    label: "Batch Recalled",
    colorClass: "border-red-300 bg-red-50",
    dotClass: "bg-red-600",
  },
  duplicate_attempt: {
    icon: "🚫",
    label: "Duplicate Activation Attempt",
    colorClass: "border-orange-200 bg-orange-50",
    dotClass: "bg-orange-500",
  },
  brand_registered: {
    icon: "🏢",
    label: "Brand Registered",
    colorClass: "border-violet-200 bg-violet-50",
    dotClass: "bg-violet-500",
  },
  brand_verified: {
    icon: "✔️",
    label: "Brand Verified",
    colorClass: "border-green-200 bg-green-50",
    dotClass: "bg-green-500",
  },
  service_center_registered: {
    icon: "🏗️",
    label: "Service Center Registered",
    colorClass: "border-gray-200 bg-gray-50",
    dotClass: "bg-gray-500",
  },
};

const DEFAULT_META: EventMeta = {
  icon: "📋",
  label: "Event",
  colorClass: "border-slate-200 bg-slate-50",
  dotClass: "bg-slate-400",
};

function getStellarExpertNetwork(): string {
  const passphrase = PUBLIC_CONFIG.networkPassphrase;
  if (passphrase.includes("Test")) return "testnet";
  return "public";
}

function getStellarExpertTxUrl(txHash: string): string {
  return `https://stellar.expert/explorer/${getStellarExpertNetwork()}/tx/${txHash}`;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffSec = Math.round((date.getTime() - now) / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);
  const diffMonth = Math.round(diffDay / 30);
  const diffYear = Math.round(diffDay / 365);

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (Math.abs(diffYear) >= 1) return rtf.format(diffYear, "year");
  if (Math.abs(diffMonth) >= 1) return rtf.format(diffMonth, "month");
  if (Math.abs(diffDay) >= 1) return rtf.format(diffDay, "day");
  if (Math.abs(diffHr) >= 1) return rtf.format(diffHr, "hour");
  if (Math.abs(diffMin) >= 1) return rtf.format(diffMin, "minute");
  return rtf.format(diffSec, "second");
}

function formatAbsoluteTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function truncateTxHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

/**
 * Sorts timeline events in chronological order (earliest first).
 * Uses the createdAt timestamp as the primary sort key, with the ledger
 * number as a tiebreaker for events sharing the same timestamp.
 */
export function sortTimelineEvents(events: UnitTimelineEvent[]): UnitTimelineEvent[] {
  return [...events].sort((a, b) => {
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return a.ledger - b.ledger;
  });
}

export interface ProvenanceTimelineProps {
  events: UnitTimelineEvent[];
}

/**
 * Interactive vertical timeline displaying the complete chronological
 * lifecycle of a verified product: batch commitment, first sale & lazy
 * activation, ownership resale transfers, and authorized warranty
 * service claims. Each event links to the Stellar Expert Explorer.
 */
export function ProvenanceTimeline({ events }: ProvenanceTimelineProps) {
  const sorted = sortTimelineEvents(events);

  if (sorted.length === 0) return null;

  return (
    <div className="relative pl-8">
      {/* Vertical line */}
      <div
        className="absolute left-3 top-2 bottom-2 w-0.5 bg-slate-200"
        aria-hidden="true"
      />

      <ol className="space-y-5">
        {sorted.map((ev) => {
          const meta = EVENT_META[ev.type] ?? DEFAULT_META;
          const date = new Date(ev.createdAt);
          const txUrl = getStellarExpertTxUrl(ev.txHash);

          return (
            <li key={ev.id} className="relative">
              {/* Icon dot */}
              <span
                className={`absolute -left-[1.625rem] flex h-6 w-6 items-center justify-center rounded-full ${meta.dotClass} text-xs ring-4 ring-white`}
                aria-hidden="true"
              >
                {meta.icon}
              </span>

              <div className={`rounded-xl border ${meta.colorClass} p-3.5`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    {meta.label}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      ev.finalized
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {ev.finalized ? "Finalized" : "Pending"}
                  </span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <time dateTime={ev.createdAt} title={formatAbsoluteTime(date)}>
                    {formatRelativeTime(date)} · {formatAbsoluteTime(date)}
                  </time>
                  <span className="text-slate-400">Ledger #{ev.ledger}</span>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <a
                    href={txUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
                  >
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                      <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                    </svg>
                    {truncateTxHash(ev.txHash)}
                  </a>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
