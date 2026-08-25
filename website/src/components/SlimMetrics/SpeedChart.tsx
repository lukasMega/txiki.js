import React, {useId, useMemo, useState} from 'react';

import metricsJson from '@site/src/data/slim-metrics.generated.json';

import {AxisLabel, Controls, EmptyChart, formatPlatform, WIDTH} from './shared';
import styles from './styles.module.css';
import type {SlimMetricsData} from './types';

const metrics = metricsJson as SlimMetricsData;
const HEIGHT = 390;

export default function SpeedChart(): React.ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const runs = metrics.speed.runs.filter(run => !run.quick);
  const [runKey, setRunKey] = useState(() => runs.at(-1) ? `${runs.at(-1)!.version}/${runs.at(-1)!.platform}` : '');
  const [metricId, setMetricId] = useState(metrics.speed.metrics[0]?.id ?? '');
  const run = runs.find(item => `${item.version}/${item.platform}` === runKey) ?? runs.at(-1);
  const metric = metrics.speed.metrics.find(item => item.id === metricId) ?? metrics.speed.metrics[0];
  const values = useMemo(() => metrics.speed.profiles.map(profile => ({
    profile,
    value: run?.profiles[profile]?.[metric?.id] ?? null,
  })), [metric?.id, run]);

  if (!run || !metric) {
    return <EmptyChart>No full benchmark run exists yet.</EmptyChart>;
  }

  const available = values.filter((item): item is {profile: string; value: number} => item.value !== null);

  if (available.length === 0) {
    return <EmptyChart>Selected run has no slim-profile measurements.</EmptyChart>;
  }

  const margin = {top: 30, right: 24, bottom: 88, left: 64};
  const plotWidth = WIDTH - margin.left - margin.right;
  const plotHeight = HEIGHT - margin.top - margin.bottom;
  const max = Math.max(1.1, ...available.map(item => item.value)) * 1.08;
  const barWidth = Math.min(68, plotWidth / available.length - 14);
  const xStep = plotWidth / available.length;
  const y = (value: number): number => margin.top + plotHeight - (value / max) * plotHeight;
  const ticks = Array.from({length: 5}, (_, index) => (max * index) / 4);

  return (
    <figure className={styles.figure}>
      <figcaption id={titleId} className={styles.title}>Slim-build speed</figcaption>
      <p id={descriptionId} className={styles.description}>
        Same-run ratios against full build. {metric.direction === 'higher' ? 'Higher is faster.' : 'Lower is faster.'}
      </p>
      <Controls>
        <label>Run{' '}
          <select value={`${run.version}/${run.platform}`} onChange={event => setRunKey(event.target.value)}>
            {runs.map(item => <option key={`${item.version}/${item.platform}`} value={`${item.version}/${item.platform}`}>
              {item.version} · {formatPlatform(item.platform)}
            </option>)}
          </select>
        </label>
        <label>Metric{' '}
          <select value={metric.id} onChange={event => setMetricId(event.target.value)}>
            {metrics.speed.metrics.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      </Controls>
      <div className={styles.chartScroll} tabIndex={0} aria-label="Scrollable benchmark chart">
        <svg className={styles.chart} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}>
        <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} className={styles.frame} />
        {ticks.map(value => <g key={value}>
          <line x1={margin.left} x2={WIDTH - margin.right} y1={y(value)} y2={y(value)} className={styles.grid} />
          <AxisLabel x={margin.left - 10} y={y(value) + 4} anchor="end">{value.toFixed(2)}×</AxisLabel>
        </g>)}
        <line x1={margin.left} x2={WIDTH - margin.right} y1={y(1)} y2={y(1)} className={styles.reference} />
        <AxisLabel x={WIDTH - margin.right - 4} y={y(1) - 7} anchor="end">full 1.00×</AxisLabel>
        {available.map((item, index) => {
          const x = margin.left + index * xStep + (xStep - barWidth) / 2;
          const top = y(item.value);

          return <g key={item.profile} className={styles[`series${index % 6}`]}>
            <rect x={x} y={top} width={barWidth} height={margin.top + plotHeight - top} className={styles.bar}
              tabIndex={0} role="img" aria-label={`${item.profile}: ${item.value.toFixed(2)} times full`}>
              <title>{item.profile}: {item.value.toFixed(3)}× full</title>
            </rect>
            <AxisLabel x={x + barWidth / 2} y={top - 8}>{item.value.toFixed(2)}×</AxisLabel>
            <text transform={`translate(${x + barWidth / 2} ${HEIGHT - 70}) rotate(-35)`}
              textAnchor="end" className={styles.axisLabel}>{item.profile}</text>
          </g>;
        })}
        <text transform={`translate(18 ${margin.top + plotHeight / 2}) rotate(-90)`}
          textAnchor="middle" className={styles.axisLabel}>{metric.unit}</text>
        </svg>
      </div>
      <p className={styles.provenance}>
        <code>{run.commit.slice(0, 8)}</code> · {new Date(run.date).toISOString().slice(0, 10)} ·
        {' '}{String(run.runner.image ?? 'unknown runner')} · {String(run.toolchain.cc ?? 'unknown compiler')}
      </p>
      <details className={styles.dataTable}>
        <summary>Exact benchmark ratios</summary>
        <div className={styles.tableScroll}>
          <table><thead><tr><th>profile</th><th>{metric.label}</th><th>direction</th></tr></thead>
            <tbody>{values.map(item => <tr key={item.profile}><td><code>{item.profile}</code></td>
              <td>{item.value === null ? '—' : `${item.value.toFixed(3)}×`}</td><td>{metric.direction} is better</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
