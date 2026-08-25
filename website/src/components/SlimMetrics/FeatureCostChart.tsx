import React, {useId, useMemo, useState} from 'react';

import metricsJson from '@site/src/data/slim-metrics.generated.json';

import {AxisLabel, Controls, EmptyChart, formatBytes, formatPlatform, WIDTH} from './shared';
import styles from './styles.module.css';
import type {SlimMetricsData} from './types';

const metrics = metricsJson as SlimMetricsData;
const HEIGHT_PER_BAR = 48;

export default function FeatureCostChart(): React.ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const studies = metrics.featureCosts.studies;
  const defaultStudy = studies.find(item => item.platform === 'linux-x86_64') ?? studies.at(-1);
  const [studyId, setStudyId] = useState(defaultStudy?.id ?? '');
  const study = studies.find(item => item.id === studyId) ?? defaultStudy;
  const catalog = new Map(metrics.featureCosts.catalog.map(feature => [feature.id, feature]));
  const pairs = useMemo(() => [...(study?.pairs ?? [])].sort((a, b) => b.deltaBytes - a.deltaBytes), [study]);

  if (!study || pairs.length === 0) {
    return <EmptyChart>No paired feature study exists yet.</EmptyChart>;
  }

  const margin = {top: 20, right: 118, bottom: 54, left: 120};
  const height = margin.top + margin.bottom + pairs.length * HEIGHT_PER_BAR;
  const plotWidth = WIDTH - margin.left - margin.right;
  const max = Math.max(...pairs.map(pair => Math.abs(pair.deltaBytes)), 1);
  const scale = (value: number): number => (Math.abs(value) / max) * plotWidth;
  const unmeasured = metrics.featureCosts.catalog.filter(feature => !feature.measured);

  return (
    <figure className={styles.figure}>
      <figcaption id={titleId} className={styles.title}>Marginal feature cost</figcaption>
      <p id={descriptionId} className={styles.description}>
        Paired builds differ by one removable capability. Bars cannot be summed because linked code overlaps.
      </p>
      <Controls>
        <label>Study{' '}
          <select value={study.id} onChange={event => setStudyId(event.target.value)}>
            {studies.map(item => (
              <option key={item.id} value={item.id}>{item.tag ?? item.id} · {formatPlatform(item.platform)}</option>
            ))}
          </select>
        </label>
      </Controls>
      <div className={styles.chartScroll} tabIndex={0} aria-label="Scrollable feature-cost chart">
        <svg className={styles.chart} viewBox={`0 0 ${WIDTH} ${height}`} role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}>
        <rect x={margin.left} y={margin.top} width={plotWidth} height={pairs.length * HEIGHT_PER_BAR}
          className={styles.frame} />
        {pairs.map((pair, index) => {
          const feature = catalog.get(pair.id);
          const y = margin.top + index * HEIGHT_PER_BAR + 11;
          const width = scale(pair.deltaBytes);

          return (
            <g key={pair.id}>
              <AxisLabel x={margin.left - 12} y={y + 16} anchor="end">{feature?.label ?? pair.id}</AxisLabel>
              <rect x={margin.left} y={y} width={width} height="24" className={`${styles.bar} ${styles[`series${index % 6}`]}`}
                tabIndex={0} role="img"
                aria-label={`${feature?.label ?? pair.id}: ${formatBytes(pair.deltaBytes)}`}>
                <title>{pair.source}: {pair.onBytes.toLocaleString('en-US')} − {pair.offBytes.toLocaleString('en-US')} bytes</title>
              </rect>
              <AxisLabel x={margin.left + width + 8} y={y + 16} anchor="start">+{formatBytes(pair.deltaBytes)}</AxisLabel>
            </g>
          );
        })}
        <AxisLabel x={margin.left + plotWidth / 2} y={height - 12}>Added executable size</AxisLabel>
        </svg>
      </div>
      <p className={styles.provenance}>
        <code>{study.tag ?? study.id}</code> · <code>{study.commit.slice(0, 8)}</code> · {formatPlatform(study.platform)} ·
        {' '}{study.provenance ?? study.recipe}
      </p>
      {unmeasured.length > 0 && (
        <details className={styles.dataTable}>
          <summary>{unmeasured.length} removable capabilities await paired measurements</summary>
          <ul>{unmeasured.map(feature => <li key={feature.id}><code>{feature.setting}</code> — {feature.label}</li>)}</ul>
        </details>
      )}
      <details className={styles.dataTable}>
        <summary>Exact paired sizes</summary>
        <div className={styles.tableScroll}>
          <table>
            <thead><tr><th>feature</th><th>without</th><th>with</th><th>cost</th></tr></thead>
            <tbody>{pairs.map(pair => <tr key={pair.id}>
              <td>{catalog.get(pair.id)?.label ?? pair.id}</td><td>{pair.offBytes.toLocaleString('en-US')} B</td>
              <td>{pair.onBytes.toLocaleString('en-US')} B</td><td>+{pair.deltaBytes.toLocaleString('en-US')} B</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
