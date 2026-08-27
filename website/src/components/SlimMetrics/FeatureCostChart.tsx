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
  // Prefer a controlled paired study over the deltas derived from released
  // profiles: the latter exist for every platform and release but only cover the
  // three features the published matrix happens to vary.
  const defaultStudy = studies.find(item => item.pairs.some(pair => pair.deltaLinkedBytes !== undefined))
    ?? studies.reduce<typeof studies[number] | undefined>(
      (best, item) => (item.pairs.length > (best?.pairs.length ?? 0) ? item : best),
      undefined,
    );
  const [studyId, setStudyId] = useState(defaultStudy?.id ?? '');
  const study = studies.find(item => item.id === studyId) ?? defaultStudy;
  const catalog = new Map(metrics.featureCosts.catalog.map(feature => [feature.id, feature]));
  // Executable file size is page-quantized -- Mach-O pads segments to 16 KB on
  // arm64 -- so a feature worth a few KB of bytecode barely moves it. Plot linked
  // section bytes when the study measured them, and say which one is on the axis.
  const linked = (study?.pairs.length ?? 0) > 0 && study!.pairs.every(pair => pair.deltaLinkedBytes !== undefined);
  const cost = (pair: {deltaBytes: number; deltaLinkedBytes?: number}): number =>
    (linked ? pair.deltaLinkedBytes! : pair.deltaBytes);
  const pairs = useMemo(
    () => [...(study?.pairs ?? [])].sort((a, b) => cost(b) - cost(a)),
    [study, linked],
  );

  if (!study || pairs.length === 0) {
    return <EmptyChart>No paired feature study exists yet.</EmptyChart>;
  }

  const margin = {top: 20, right: 118, bottom: 54, left: 120};
  const height = margin.top + margin.bottom + pairs.length * HEIGHT_PER_BAR;
  const plotWidth = WIDTH - margin.left - margin.right;
  const max = Math.max(...pairs.map(pair => Math.abs(cost(pair))), 1);
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
          const width = scale(cost(pair));
          const on = linked ? pair.onLinkedBytes! : pair.onBytes;
          const off = linked ? pair.offLinkedBytes! : pair.offBytes;

          return (
            <g key={pair.id}>
              <AxisLabel x={margin.left - 12} y={y + 16} anchor="end">{feature?.label ?? pair.id}</AxisLabel>
              <rect x={margin.left} y={y} width={width} height="24" className={`${styles.bar} ${styles[`series${index % 6}`]}`}
                tabIndex={0} role="img"
                aria-label={`${feature?.label ?? pair.id}: ${formatBytes(cost(pair))}`}>
                <title>{pair.source ?? feature?.setting}: {on.toLocaleString('en-US')} − {off.toLocaleString('en-US')} bytes</title>
              </rect>
              <AxisLabel x={margin.left + width + 8} y={y + 16} anchor="start">+{formatBytes(cost(pair))}</AxisLabel>
            </g>
          );
        })}
        <AxisLabel x={margin.left + plotWidth / 2} y={height - 12}>
          {linked ? 'Added linked code and data' : 'Added executable size'}
        </AxisLabel>
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
        {linked && (
          <p className={styles.description}>
            Cost is linked section bytes. Executable file size is shown beside it and is usually smaller:
            segments are padded to a page boundary, so a saving under ~16 KB may not move the download at all.
          </p>
        )}
        <div className={styles.tableScroll}>
          <table>
            <thead><tr>
              <th>feature</th><th>without</th><th>with</th><th>cost</th>{linked && <th>file size delta</th>}
            </tr></thead>
            <tbody>{pairs.map(pair => <tr key={pair.id}>
              <td>{catalog.get(pair.id)?.label ?? pair.id}</td>
              <td>{(linked ? pair.offLinkedBytes! : pair.offBytes).toLocaleString('en-US')} B</td>
              <td>{(linked ? pair.onLinkedBytes! : pair.onBytes).toLocaleString('en-US')} B</td>
              <td>+{cost(pair).toLocaleString('en-US')} B</td>
              {linked && <td>+{pair.deltaBytes.toLocaleString('en-US')} B</td>}
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
