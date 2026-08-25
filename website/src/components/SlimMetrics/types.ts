export type SizeUnit = 'raw' | 'archive';

export interface SizeArtifact {
  platform: string;
  profile: string;
  raw: number;
  archive: number;
}

export interface SizeRelease {
  tag: string;
  commit: string;
  publishedAt: string;
  artifacts: SizeArtifact[];
}

export interface FeaturePair {
  id: string;
  onBytes: number;
  offBytes: number;
  deltaBytes: number;
  source: string;
}

export interface FeatureStudy {
  id: string;
  tag?: string;
  commit: string;
  platform: string;
  recipe: string;
  provenance?: string;
  pairs: FeaturePair[];
}

export interface SpeedMetric {
  id: string;
  label: string;
  unit: string;
  direction: 'lower' | 'higher';
}

export interface SpeedRun {
  version: string;
  commit: string;
  date: string;
  platform: string;
  quick: boolean;
  runner: Record<string, unknown>;
  toolchain: Record<string, unknown>;
  sampling: Record<string, unknown>;
  profiles: Record<string, Record<string, number | null> | null>;
}

export interface SlimMetricsData {
  schemaVersion: number;
  releaseSizes: {
    platforms: string[];
    profiles: string[];
    releases: SizeRelease[];
  };
  featureCosts: {
    catalog: Array<{
      id: string;
      label: string;
      category: string;
      setting: string;
      measured: boolean;
    }>;
    studies: FeatureStudy[];
  };
  speed: {
    profiles: string[];
    metrics: SpeedMetric[];
    runs: SpeedRun[];
  };
}
