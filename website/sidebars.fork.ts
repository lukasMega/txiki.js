import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

import base from './sidebars';

type SidebarItemConfig = Extract<SidebarsConfig[string], unknown[]>[number];

// Fork-only sidebar. `sidebars.ts` is upstream's and is kept byte-identical to it; the
// fork's pages are spliced in here instead, and docusaurus.fork.config.ts points the
// preset's `sidebarPath` at this file. Same split as docusaurus.fork.config.ts itself.
//
// Under upstream's config this file is never loaded, so the fork's pages simply do not
// appear in the sidebar -- which is correct: `ci-docs.yml` builds with upstream's config
// to validate content, not to render the fork's navigation.

const FORK_PAGES = [
  'slim-builds',
  'downloads',
  'size-and-speed',
  'testing-slim-builds',
  'fork-and-ci',
];

const forkCategory: SidebarItemConfig = {
  type: 'category',
  label: 'Slim builds',
  collapsed: false,
  // `className` is styled by src/css/fork.css, which only the fork config loads.
  items: FORK_PAGES.map((id) => ({type: 'doc' as const, id, className: 'fork-only'})),
};

// Splice by label rather than by index: upstream reorders its own categories, and landing
// the fork's pages in the wrong place is the kind of breakage nothing else would catch.
const docsSidebar = [...(base.docsSidebar as SidebarItemConfig[])];
const introIndex = docsSidebar.findIndex(
  (item) => typeof item === 'object' && 'label' in item && item.label === 'Introduction',
);

if (introIndex === -1) {
  throw new Error("sidebars.fork.ts: no 'Introduction' category in upstream's sidebar; the splice point is stale");
}

docsSidebar.splice(introIndex + 1, 0, forkCategory);

const sidebars: SidebarsConfig = {
  ...base,
  docsSidebar,
};

export default sidebars;
