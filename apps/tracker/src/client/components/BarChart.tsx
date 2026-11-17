// 件数の時系列を uPlot の棒グラフで描く
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

type Props = {
  /** [区間の先頭(UNIX秒), 件数] */
  points: [number, number][];
  interval: "hour" | "day";
  height?: number;
};

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function BarChart({ points, interval, height = 140 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const xs = points.map(([t]) => t);
    const ys = points.map(([, n]) => n);
    const bar = cssVar("--accent");
    const axis = cssVar("--muted");
    const grid = cssVar("--border");
    const axisStyle = {
      stroke: axis,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
      font: "11px system-ui, sans-serif",
    };

    const plot = new uPlot(
      {
        width: el.clientWidth,
        height,
        legend: { show: false },
        cursor: { y: false, points: { show: false } },
        scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(1, max)] } },
        axes: [
          {
            ...axisStyle,
            values: interval === "day" ? "{M}/{D}" : "{H}:00",
            space: 50,
          },
          {
            ...axisStyle,
            size: 40,
            space: 30,
            values: (_u, vals) => vals.map((v) => (Number.isInteger(v) ? String(v) : "")),
          },
        ],
        series: [
          {},
          {
            label: "件数",
            stroke: bar,
            fill: bar,
            width: 0,
            paths: uPlot.paths.bars?.({ size: [0.7, 24] }),
            points: { show: false },
          },
        ],
      },
      [xs, ys],
      el,
    );

    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [points, interval, height]);

  const total = points.reduce((s, [, n]) => s + n, 0);
  return (
    <div
      ref={ref}
      className="chart"
      role="img"
      aria-label={`${interval === "day" ? "日" : "時間"}ごとの件数。合計 ${total} 件`}
    />
  );
}
