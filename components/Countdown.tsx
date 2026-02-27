"use client";

import { useEffect, useMemo, useState } from "react";
import { useMounted } from "@/lib/useMounted";

type CountdownProps = {
  targetIsoUtc: string;
  label?: string;
};

function getRemainingMs(targetIsoUtc: string): number {
  const targetMs = Date.parse(targetIsoUtc);
  if (Number.isNaN(targetMs)) {
    return 0;
  }
  return Math.max(0, targetMs - Date.now());
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const padded = (value: number) => String(value).padStart(2, "0");
  return `${padded(days)}d ${padded(hours)}h ${padded(minutes)}m ${padded(seconds)}s`;
}

export default function Countdown({ targetIsoUtc, label }: CountdownProps) {
  const mounted = useMounted();
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    if (!mounted) {
      return;
    }

    const tick = () => {
      setRemainingMs(getRemainingMs(targetIsoUtc));
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [mounted, targetIsoUtc]);

  const formatted = useMemo(() => {
    if (!mounted) {
      return "--d --h --m --s";
    }

    return formatRemaining(remainingMs);
  }, [mounted, remainingMs]);

  return (
    <div className="countdown" aria-live="polite">
      {label ? <span className="countdown-label">{label}</span> : null}
      <span className="countdown-time">{formatted}</span>
    </div>
  );
}
