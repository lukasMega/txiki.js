import type {ReactNode} from 'react';

import styles from './styles.module.css';

// Marks a page that exists only in the slim-builds fork. Upstream txiki.js has no
// equivalent, so a reader arriving from a search result or a shared link needs to be told
// where they are and where the original project lives.
//
// Fork-owned, like every file under website/src/components. It uses a CSS module rather
// than adding rules to src/css/custom.css, which is upstream's.

export default function ForkNotice(): ReactNode {
  return (
    <aside className={styles.banner} aria-label="Fork-only documentation">
      <span className={styles.badge}>only on this fork</span>
      <p className={styles.text}>
        This page documents <strong>txiki.js with slim builds</strong> — a fork that adds
        size-reduced build profiles and publishes prebuilt binaries. It is not part of
        upstream txiki.js: see{' '}
        <a href="https://txikijs.org" target="_blank" rel="noopener noreferrer">
          txikijs.org
        </a>{' '}
        and{' '}
        <a href="https://github.com/saghul/txiki.js" target="_blank" rel="noopener noreferrer">
          saghul/txiki.js
        </a>{' '}
        for the original project and its documentation.
      </p>
    </aside>
  );
}
