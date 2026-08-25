import React, {useId, useMemo, useState} from 'react';

import metricsJson from '@site/src/data/slim-metrics.generated.json';

import {AxisLabel, Controls, EmptyChart, formatMiB, formatPlatform, WIDTH} from './shared';
import styles from './styles.module.css';
import type {SizeUnit, SlimMetricsData} from './types';

const metrics = metricsJson as SlimMetricsData;
const DEFAULT_PROFILES = new Set(['min', 'balanced-min', 'ffi-tls-sqlite']);
const HEIGHT = 340;
const MARGIN = {top: 24, right: 24, bottom: 64, left: 72};

export default function ReleaseSizeChart(): React.ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const [platform, setPlatform] = useState('linux-x86_64');
  const [unit, setUnit] = useState<SizeUnit>('raw');
  const [selected, setSelected] = useState(() => new Set(DEFAULT_PROFILES));
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const releases = metrics.releaseSizes.releases;
  const series = useMemo(() => metrics.releaseSizes.profiles.filter(profile => selected.has(profile)).map(profile => ({
    profile,
    values: releases.map(release => ({
      release,
      value: release.artifacts.find(item => item.platform === platform && item.profile === profile)?.[unit] ?? null,
    })),
  })), [platform, releases, selected, unit]);
  const values = series.flatMap(item => item.values.map(point => point.value).filter((value): value is number => value !== null));

  if (releases.length === 0 || values.length === 0) {
    return <EmptyChart>No released-size history exists yet.</EmptyChart>;
  }

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const padding = Math.max((maxValue - minValue) * 0.1, maxValue * 0.03, 1);
  const domainMin = Math.max(0, minValue - padding);
  const domainMax = maxValue + padding;
  const x = (index: number): number => {
    if (releases.length === 1) {
      return MARGIN.left + plotWidth / 2;
    }

    return MARGIN.left + (index / (releases.length - 1)) * plotWidth;
  };
  const y = (value: number): number => MARGIN.top + ((domainMax - value) / (domainMax - domainMin)) * plotHeight;
  const ticks = Array.from({length: 5}, (_, index) => domainMin + ((domainMax - domainMin) * index) / 4);
  const hoveredRelease = hoverIndex === null ? null : releases[hoverIndex];
  const hoveredValues = hoverIndex === null ? [] : series.flatMap(item => {
    const value = item.values[hoverIndex]?.value;

    return value === null || value === undefined ? [] : [{profile: item.profile, value}];
  });
  const tooltipWidth = 250;
  const tooltipHeight = 34 + hoveredValues.length * 18;
  const tooltipX = hoverIndex === null ? 0 : Math.min(x(hoverIndex) + 14, WIDTH - MARGIN.right - tooltipWidth);

  const updateHover = (event: React.PointerEvent<SVGSVGElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * WIDTH;

    if (svgX < MARGIN.left || svgX > WIDTH - MARGIN.right) {
      setHoverIndex(null);

      return;
    }

    const index = releases.length === 1 ? 0 : Math.round(((svgX - MARGIN.left) / plotWidth) * (releases.length - 1));
    setHoverIndex(Math.max(0, Math.min(releases.length - 1, index)));
  };

  const toggleProfile = (profile: string): void => {
    setSelected(current => {
      const next = new Set(current);

      if (next.has(profile)) {
        next.delete(profile);
      } else {
        next.add(profile);
      }

      return next.size > 0 ? next : current;
    });
  };

  return (
    <figure className={styles.figure}>
      <figcaption id={titleId} className={styles.title}>Released artifact size</figcaption>
      <p id={descriptionId} className={styles.description}>
        Exact bytes from published ZIP files. Hover chart for exact values. Toggle platform, unit, or profile.
      </p>
      <Controls>
        <label>Platform{' '}
          <select value={platform} onChange={event => setPlatform(event.target.value)}>
            {metrics.releaseSizes.platforms.map(value => <option key={value} value={value}>{formatPlatform(value)}</option>)}
          </select>
        </label>
        <label>Size{' '}
          <select value={unit} onChange={event => setUnit(event.target.value as SizeUnit)}>
            <option value="raw">Unpacked executable</option>
            <option value="archive">Download ZIP</option>
          </select>
        </label>
      </Controls>
      <div className={styles.legend} aria-label="Profiles">
        {metrics.releaseSizes.profiles.map((profile, index) => (
          <label key={profile} className={styles.legendItem}>
            <input type="checkbox" checked={selected.has(profile)} onChange={() => toggleProfile(profile)} />
            <span className={`${styles.swatch} ${styles[`series${index % 6}`]}`} />
            <code>{profile}</code>
          </label>
        ))}
      </div>
      <div className={styles.chartScroll} tabIndex={0} aria-label="Scrollable release-size chart">
        <svg className={styles.chart} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
          aria-labelledby={`${titleId} ${descriptionId}`} onPointerMove={updateHover} onPointerLeave={() => setHoverIndex(null)}>
        <rect x={MARGIN.left} y={MARGIN.top} width={plotWidth} height={plotHeight} className={styles.frame} />
        {ticks.map(value => (
          <g key={value}>
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(value)} y2={y(value)} className={styles.grid} />
            <AxisLabel x={MARGIN.left - 10} y={y(value) + 4} anchor="end">{formatMiB(value)}</AxisLabel>
          </g>
        ))}
        {releases.map((release, index) => (
          <AxisLabel key={release.tag} x={x(index)} y={HEIGHT - 35}>{release.tag}</AxisLabel>
        ))}
        {series.map(item => {
          const index = metrics.releaseSizes.profiles.indexOf(item.profile);
          const points = item.values.flatMap((point, pointIndex) => point.value === null ? [] : [[x(pointIndex), y(point.value), point]] as const);

          return (
            <g key={item.profile} className={`${styles.series} ${styles[`series${index % 6}`]}`}>
              {points.length > 1 && <polyline points={points.map(point => `${point[0]},${point[1]}`).join(' ')} />}
              {points.map(([cx, cy, point]) => (
                <circle key={point.release.tag} cx={cx} cy={cy} r="6" tabIndex={0}
                  aria-label={`${item.profile}, ${point.release.tag}, ${point.value!.toLocaleString('en-US')} bytes`}
                  onFocus={() => setHoverIndex(releases.indexOf(point.release))} onBlur={() => setHoverIndex(null)}>
                  <title>{item.profile}: {formatMiB(point.value!)} ({point.value!.toLocaleString('en-US')} bytes)</title>
                </circle>
              ))}
            </g>
          );
        })}
        {hoveredRelease && hoveredValues.length > 0 && hoverIndex !== null && (
          <g className={styles.tooltip} pointerEvents="none">
            <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} className={styles.hoverLine} />
            <rect x={tooltipX} y={MARGIN.top + 10} width={tooltipWidth} height={tooltipHeight} rx="4" />
            <text x={tooltipX + 10} y={MARGIN.top + 31}>{hoveredRelease.tag}</text>
            {hoveredValues.map(({profile, value}, index) => (
              <text key={profile} x={tooltipX + 10} y={MARGIN.top + 50 + index * 18}>
                {profile}: {value.toLocaleString('en-US')} B
              </text>
            ))}
          </g>
        )}
        <AxisLabel x={MARGIN.left + plotWidth / 2} y={HEIGHT - 8}>Release</AxisLabel>
        <text transform={`translate(18 ${MARGIN.top + plotHeight / 2}) rotate(-90)`}
          textAnchor="middle" className={styles.axisLabel}>Size (MiB)</text>
        </svg>
      </div>
      <details className={styles.dataTable}>
        <summary>Exact released sizes</summary>
        <div className={styles.tableScroll}>
          <table>
            <thead><tr><th>release</th><th>profile</th><th>platform</th><th>{unit}</th></tr></thead>
            <tbody>{series.flatMap(item => item.values.map(point => point.value === null ? null : (
              <tr key={`${point.release.tag}-${item.profile}`}>
                <td><code>{point.release.tag}</code></td><td><code>{item.profile}</code></td>
                <td>{formatPlatform(platform)}</td><td>{point.value.toLocaleString('en-US')} B</td>
              </tr>
            )))}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
