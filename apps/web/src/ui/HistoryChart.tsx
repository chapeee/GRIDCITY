import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { neutrals } from '../design/tokens';

interface HistoryChartProps {
  label: string;
  times: readonly number[];
  /** null renders as a gap (no data), never as zero. */
  values: readonly (number | null)[];
  color: string;
  range?: [number, number];
  /** Dashed line at the warning threshold, in the degraded accent. */
  threshold?: { value: number; color: string };
  format?: (value: number) => string;
  width?: number;
  height?: number;
}

/** A wider uPlot chart with a time axis, for the history panel. */
export function HistoryChart({
  label,
  times,
  values,
  color,
  range,
  threshold,
  format = (value) => String(Math.round(value)),
  width = 560,
  height = 110,
}: HistoryChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // The latest data, so a rebuilt chart starts with it instead of empty.
  const dataRef = useRef<uPlot.AlignedData>([[], []]);
  // Primitives, not the object: a new object each render must not rebuild the chart.
  const thresholdValue = threshold?.value;
  const thresholdColor = threshold?.color;

  // Declared before the chart effect, so a chart built in the same commit gets this data.
  useEffect(() => {
    dataRef.current = [times.map((t) => t / 1000), [...values]] as uPlot.AlignedData;
    plotRef.current?.setData(dataRef.current);
  }, [times, values]);

  useEffect(() => {
    if (!containerRef.current) return;
    const axis = {
      stroke: neutrals.muted,
      grid: { stroke: 'rgba(143,227,255,0.07)', width: 1 },
      ticks: { stroke: 'rgba(143,227,255,0.12)', width: 1 },
      font: '10px "IBM Plex Mono", monospace',
    };
    const plot = new uPlot(
      {
        width,
        height,
        legend: { show: false },
        cursor: { y: false, points: { show: false } },
        select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        scales: {
          x: { time: true },
          y: range ? { range: () => range } : { range: (_u, _min, max) => [0, Math.max(1, max)] },
        },
        axes: [
          { ...axis, size: 26 },
          { ...axis, size: 70, values: (_u, ticks) => ticks.map((tick) => format(tick)) },
        ],
        series: [
          {},
          {
            label,
            stroke: color,
            width: 1.25,
            fill: `${color}1f`,
            spanGaps: false,
            points: { show: false },
          },
        ],
        hooks:
          thresholdValue !== undefined && thresholdColor
            ? {
                draw: [
                  (u) => {
                    const y = u.valToPos(thresholdValue, 'y', true);
                    const ctx = u.ctx;
                    ctx.save();
                    ctx.strokeStyle = thresholdColor;
                    ctx.setLineDash([4, 4]);
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(u.bbox.left, y);
                    ctx.lineTo(u.bbox.left + u.bbox.width, y);
                    ctx.stroke();
                    ctx.restore();
                  },
                ],
              }
            : {},
      },
      dataRef.current,
      containerRef.current,
    );
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, [color, format, height, label, range, thresholdValue, thresholdColor, width]);

  return <div ref={containerRef} className="history-chart" role="img" aria-label={label} />;
}
