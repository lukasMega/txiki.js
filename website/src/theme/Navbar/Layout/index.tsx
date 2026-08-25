import type {ReactNode} from 'react';
import type {Props} from '@theme/Navbar/Layout';
import NavbarLayout from '@theme-original/Navbar/Layout';

import ForkNotice from '@site/src/components/ForkNotice';

export default function NavbarLayoutWrapper(props: Props): ReactNode {
  return (
    <>
      <NavbarLayout {...props} />
      <ForkNotice />
    </>
  );
}
