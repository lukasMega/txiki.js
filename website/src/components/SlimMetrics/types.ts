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
  // Sum of the non-zerofill sections. Present only on paired studies, and the
  // number the chart plots when it is: executable file size is page-quantized
  // (16 KB segments on Mach-O arm64), so it cannot resolve a small feature.
  onLinkedBytes?: number;
  offLinkedBytes?: number;
  deltaLinkedBytes?: number;
  // Only the derived published-profile pairs carry one ("ffi minus min"); a
  // paired study's provenance lives on the study, so the chart falls back to
  // the catalog's build setting there.
  source?: string;
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
