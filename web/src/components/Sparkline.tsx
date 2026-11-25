// A tiny inline chart: one line with a soft fill, no axes. The numbers it
// shows are always also given as text nearby; this is decoration with a label.
import { useId } from "react";

export function Sparkline({
  values,
  label,
  width = 96,
  height = 28,
}: { values: number[]; label: string; width?: number; height?: number }) {
  const id = useId();
  const n = values.length;
  if (n === 0) return null;
  const max = Math.max(...values, 0);
  const pad = 2;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1));
  const y = (v: number) =>
    max <= 0 ? height - pad : height - pad - (v / max) * (height - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${x(n - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  const last = values[n - 1] ?? 0;
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id}-g)`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(n - 1)} cy={y(last)} r="2" fill="currentColor" />
    </svg>
  );
}
