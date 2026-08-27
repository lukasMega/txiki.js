import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

import base from './docusaurus.config';

// Fork-only Docusaurus config. `docusaurus.config.ts` is upstream's and is kept
// byte-identical to it -- the same split as `cmake/slim.cmake` and `slim.mk` --
// so the fork's delta is this new file, not an edit to one upstream changes.
// Used via `docusaurus build --config ./docusaurus.fork.config.ts`.

const ORG = 'lukasMega';
const PROJECT = 'txiki.js-with-slim-builds';
const REPO = `https://github.com/${ORG}/${PROJECT}`;

// Cookieless pageview collector (deno-kv-analytics). Both values come from the
// environment and are deliberately not hardcoded -- not even assembled from parts,
// which still reconstructs the host for anyone reading the file. Unset (the default,
// and any fork of this fork) omits the beacon entirely rather than emitting a tag
// that 404s on every page.
//
// The scheme is optional so a bare `stats.example.com` cannot silently become a
// *relative* `<script src>` resolved against the docs host.
const COLLECTOR_RAW = process.env.COLLECTOR_ORIGIN?.trim().replace(/\/+$/, '');
const COLLECTOR = COLLECTOR_RAW
  ? /^https?:\/\//.test(COLLECTOR_RAW)
    ? COLLECTOR_RAW
    : `https://${COLLECTOR_RAW}`
  : undefined;

// Must be an id in the collector's `SITES` env var. An unlisted id resolves to null,
// and the collector then returns the same 1x1 gif while writing nothing -- so a typo
// here fails silently. Verify against `GET /sites` on the collector.
const SITE_ID = process.env.COLLECTOR_SITE_ID ?? 'txiki';

// Spreading `base` is shallow: `presets` and `themeConfig` would still be the very
// objects upstream's config exported, so every override below rebuilds the level it
// touches rather than assigning into it.

const [basePresetName, basePresetOptions] = base.presets![0] as ['classic', Preset.Options];

// Retarget by matching upstream's href rather than by array index, so an upstream
// reordering of the navbar can't silently retarget the wrong item.
const NAVBAR_REWRITES: Record<string, string> = {
  'https://github.com/saghul/txiki.js': REPO,
  'https://github.com/saghul/txiki.js/releases': `${REPO}/releases`,
};

const navbarItems = (base.themeConfig!.navbar as {items: Record<string, unknown>[]}).items;
const forkNavbarItems = navbarItems.map((item) => {
  const href = item.href as string | undefined;

  return href && href in NAVBAR_REWRITES ? {...item, href: NAVBAR_REWRITES[href]} : item;
});

if (forkNavbarItems.every((item, i) => item === navbarItems[i])) {
  throw new Error('docusaurus.fork.config.ts: no navbar item matched an upstream href; NAVBAR_REWRITES is stale');
}

// Search is off on the fork: upstream's Algolia index is a crawl of txikijs.org, so it can
// never contain a fork-only page and every hit navigates the reader off-site.
//
// The key is *removed*, not set to `undefined`. preset-classic decides whether to load
// @docusaurus/theme-search-algolia with `if (themeConfig.algolia)`, so both spellings keep
// the theme out -- but a present-but-undefined key still answers true to `'algolia' in
// themeConfig`, which is how Docusaurus tests for several other themeConfig fields. Leaving
// a hollow key around is a trap for whatever checks it that way next.
const {algolia: _algoliaOff, ...baseThemeConfig} = base.themeConfig!;

const config: Config = {
  ...base,

  url: `https://${ORG.toLowerCase()}.github.io`,
  baseUrl: `/${PROJECT}/`,

  customFields: {
    ...base.customFields,
    forkDocs: true,
  },

  organizationName: ORG,
  projectName: PROJECT,

  // Analytics is fork-only and lives here, never in upstream's config: that file is
  // kept byte-identical, and a beacon added there would both follow a sync back into
  // txikijs.org and conflict on every upstream merge.
  //
  // Appended to `base.headTags` rather than assigned: upstream has none today, but the
  // shallow spread above means assigning would silently drop them the day it adds one.
  headTags: [
    ...(base.headTags ?? []),
    ...(COLLECTOR
      ? [
          {
            tagName: 'script',
            attributes: {
              defer: 'true',
              src: `${COLLECTOR}/s.js`,
              // Required: lukasmega.github.io is a shared host that no site can claim,
              // so the collector cannot resolve the tenant from the request Host and
              // falls through to this allowlisted id.
              'data-site': SITE_ID,
            },
          },
        ]
      : []),
  ],

  presets: [
    [
      basePresetName,
      {
        ...basePresetOptions,
        docs: {
          ...(basePresetOptions.docs as object),
          editUrl: `${REPO}/tree/slim/website/`,
          // sidebars.ts stays upstream's; sidebars.fork.ts imports it and splices in the
          // fork's category.
          sidebarPath: './sidebars.fork.ts',
        },
        theme: {
          // `customCss` takes an array, which is what lets the fork add a stylesheet
          // without editing upstream's src/css/custom.css.
          customCss: [
            (basePresetOptions.theme as {customCss: string}).customCss,
            './src/css/fork.css',
          ],
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    ...baseThemeConfig,
    navbar: {
      ...(base.themeConfig!.navbar as object),
      items: forkNavbarItems,
    },
  },
};

export default config;
