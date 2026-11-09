import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface SparklineProps {
  label: string;
  /** Sample timestamps, epoch ms. */
  times: readonly number[];
  /** One value per timestamp; null renders as a gap, never as zero. */
  values: readonly (number | null)[];
  color: string;
  /** Fixed y-range, e.g. [0, 100] for percentages. Omit to auto-scale. */
  range?: [number, number];
  width?: number;
  height?: number;
}

/** Tiny uPlot line chart without axes, for the focus HUD. */
export function Sparkline({
  label,
  times,
  values,
  color,
  range,
  width = 220,
  height = 36,
}: SparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const plot = new uPlot(
      {
        width,
        height,
        legend: { show: false },
        cursor: { show: false },
        select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        axes: [{ show: false }, { show: false }],
        scales: {
          x: { time: false },
          y: range ? { range: () => range } : { range: (_u, _min, max) => [0, Math.max(1, max)] },
        },
        series: [
          {},
          {
            stroke: color,
            width: 1.5,
            fill: `${color}22`,
            spanGaps: false,
            points: { show: false },
          },
        ],
      },
      [[], []],
      containerRef.current,
    );
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, [color, height, range, width]);

  useEffect(() => {
    plotRef.current?.setData([times.map((t) => t / 1000), [...values]] as uPlot.AlignedData);
  }, [times, values]);

  return <div ref={containerRef} className="sparkline" role="img" aria-label={label} />;
}
