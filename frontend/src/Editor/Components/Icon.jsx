import React, { useState, useEffect } from 'react';
// eslint-disable-next-line import/no-unresolved
import * as Icons from '@tabler/icons';
import { resolveWidgetFieldValue } from '@/_helpers/utils';
import cx from 'classnames';

export const Icon = ({ properties, styles, fireEvent, width, height, currentState, registerAction, darkMode }) => {
  const { icon } = properties;
  const { iconColor, visibility } = styles;
  const IconElement = Icons[icon];

  const color = iconColor === '#000' ? (darkMode ? '#fff' : '#000') : iconColor;

  const [showIcon, setIconVisibility] = useState(true);

  useEffect(() => {
    showIcon !== visibility &&
      setIconVisibility(
        typeof visibility !== 'boolean' ? resolveWidgetFieldValue(visibility, currentState) : visibility
      );

    registerAction('click', async function () {
      fireEvent('onClick');
    });

    registerAction('setVisibility', async function (visibility) {
      setIconVisibility(
        typeof visibility !== 'boolean' ? resolveWidgetFieldValue(visibility, currentState) : visibility
      );
    });
  }, [currentState, visibility]);

  return (
    <div className={cx('icon-widget', { 'd-none': !showIcon })}>
      <IconElement
        color={color}
        style={{ width, height }}
        onClick={(event) => {
          event.stopPropagation();
          fireEvent('onClick');
        }}
        onMouseOver={(event) => {
          event.stopPropagation();
          fireEvent('onHover');
        }}
      />
    </div>
  );
};