import React, {type ReactNode} from 'react';

import styles from './styles.module.css';

export const WIDTH = 760;

export function formatBytes(bytes: number): string {
  if (Math.abs(bytes) < 1024) {
    return `${bytes.toLocaleString('en-US')} B`;
  }

  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function formatPlatform(platform: string): string {
  const labels: Record<string, string> = {
    'linux-x86_64': 'Linux x86-64',
    'linux-arm64': 'Linux arm64',
    'macos-arm64': 'macOS arm64',
    'windows-x86_64': 'Windows x86-64',
  };

  return labels[platform] ?? platform;
}

export function Controls({children}: {children: ReactNode}): React.ReactElement {
  return <div className={styles.controls}>{children}</div>;
}

export function EmptyChart({children}: {children: ReactNode}): React.ReactElement {
  return <p className={styles.empty}>{children}</p>;
}

export function AxisLabel({x, y, children, anchor = 'middle'}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: 'start' | 'middle' | 'end';
}): React.ReactElement {
  return <text x={x} y={y} textAnchor={anchor} className={styles.axisLabel}>{children}</text>;
}
