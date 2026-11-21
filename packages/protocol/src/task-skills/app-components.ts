/** Dependency-free source asset. Generated apps copy this as components.mjs. */
export const APP_COMPONENTS_JS: string = String.raw`let nextPickerId = 0;

export function parseLocalDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function formatLocalDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError('A valid local date is required.');
  }
  const year = date.getFullYear();
  if (year < 1 || year > 9999) {
    throw new RangeError('The year must be between 0001 and 9999.');
  }
  return (
    String(year).padStart(4, '0') +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0')
  );
}

export function shiftCalendarMonth(date, amount) {
  const next = new Date(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + amount);
  const last = new Date(next);
  last.setMonth(last.getMonth() + 1, 0);
  next.setDate(Math.min(day, last.getDate()));
  return next;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(text, className = 'ui-button') {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function focusTarget(candidate) {
  if (
    candidate instanceof HTMLElement &&
    candidate.isConnected &&
    !candidate.closest('[inert],[hidden]') &&
    !candidate.matches(':disabled')
  ) {
    candidate.focus({ preventScroll: true });
    return document.activeElement === candidate;
  }
  return false;
}

export function createDialog(dialog, options = {}) {
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new TypeError('Use a native dialog element.');
  }
  let opener;
  let focusBeforeOpen;
  let openerId = '';
  let revision = 0;
  let disposed = false;
  let needsFocusReturn = false;
  const restoreFocus = () => {
    if (dialog.open || !needsFocusReturn) {
      return;
    }
    needsFocusReturn = false;
    const closingRevision = ++revision;
    setTimeout(() => {
      if (dialog.open || revision !== closingRevision) {
        return;
      }
      // A close handler or the user may already have moved to the next field.
      const active = document.activeElement;
      if (
        active && active !== document.body && active !== document.documentElement &&
        active !== opener && active !== focusBeforeOpen && !dialog.contains(active)
      ) {
        return;
      }
      // Close listeners and their promise handlers may replace the opener.
      const fallback = options.returnFocus?.();
      if (focusTarget(fallback) || focusTarget(opener)) {
        return;
      }
      if (openerId && focusTarget(document.getElementById(openerId))) {
        return;
      }
      focusTarget(document.querySelector('[data-dialog-fallback]'));
    }, 0);
  };
  dialog.addEventListener('close', restoreFocus);
  return {
    open(trigger = document.activeElement) {
      if (disposed) {
        throw new Error('This dialog controller was disposed.');
      }
      if (dialog.open) {
        return;
      }
      revision++;
      needsFocusReturn = true;
      opener = trigger;
      focusBeforeOpen = document.activeElement;
      openerId = '';
      if (trigger instanceof HTMLElement) {
        openerId = trigger.id;
      }
      dialog.returnValue = '';
      dialog.showModal();
      focusTarget(options.initialFocus?.());
    },
    close(value = '') {
      if (dialog.open) {
        dialog.close(value);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      dialog.removeEventListener('close', restoreFocus);
      if (dialog.open) {
        dialog.close();
      }
      restoreFocus();
    },
  };
}

export function createTimeInput(input, options = {}) {
  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError('A time field needs an input element.');
  }
  input.type = 'text';
  input.classList.add('ui-control');
  input.inputMode = 'text';
  input.placeholder = 'HH:mm';
  input.pattern = '(?:[01][0-9]|2[0-3]):[0-5][0-9]';
  const validate = (showError = true) => {
    let message = '';
    if (input.value && !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.value)) {
      message = 'Enter a time from 00:00 to 23:59 using HH:mm.';
    }
    input.setCustomValidity(message);
    if (showError) {
      input.setAttribute('aria-invalid', String(!input.validity.valid));
    }
    return input.validity.valid;
  };
  const changed = () => {
    if (validate()) {
      options.onChange?.(input.value);
    }
  };
  const clearError = () => {
    validate(false);
    input.removeAttribute('aria-invalid');
  };
  input.addEventListener('input', clearError);
  input.addEventListener('change', changed);
  input.addEventListener('blur', validate);
  validate(false);
  return {
    validate,
    dispose() {
      input.removeEventListener('input', clearError);
      input.removeEventListener('change', changed);
      input.removeEventListener('blur', validate);
    },
  };
}

export function createDatePicker(input, options = {}) {
  if (!(input instanceof HTMLInputElement) || !input.isConnected) {
    throw new TypeError('A date picker needs a connected input element.');
  }
  const root = input.closest('.ui');
  if (!root) {
    throw new Error('Place the date input inside the themed .ui root.');
  }
  const id = 'ui-date-' + ++nextPickerId;
  let minimum = '0001-01-01';
  let maximum = '9999-12-31';
  let activeDate = new Date();
  let disposed = false;
  let focusedDate;
  const readBounds = (bounds) => {
    const lower = bounds.min || '0001-01-01';
    const upper = bounds.max || '9999-12-31';
    if (!parseLocalDate(lower) || !parseLocalDate(upper) || lower > upper) {
      throw new RangeError('Date bounds must be valid ordered YYYY-MM-DD dates.');
    }
    minimum = lower;
    maximum = upper;
  };
  readBounds(options);
  const clamp = (date) => {
    const minimumDate = parseLocalDate(minimum);
    const maximumDate = parseLocalDate(maximum);
    if (date < minimumDate) {
      return minimumDate;
    }
    if (date > maximumDate) {
      return maximumDate;
    }
    return date;
  };
  const field = element('div', 'ui-date-field');
  input.before(field);
  field.append(input);
  input.type = 'text';
  input.classList.add('ui-control');
  input.inputMode = 'text';
  input.placeholder = 'YYYY-MM-DD';
  input.pattern = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
  const trigger = button('Choose date');
  trigger.disabled = input.disabled || input.readOnly;
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', id);
  trigger.setAttribute('aria-expanded', 'false');
  field.append(trigger);
  const dialog = element('dialog', 'ui-dialog ui-date-dialog');
  dialog.id = id;
  dialog.setAttribute('aria-labelledby', id + '-title');
  const header = element('header', 'ui-dialog-header');
  const title = element('h2', '', 'Choose date');
  title.id = id + '-title';
  const close = button('Close');
  header.append(title, close);
  const body = element('div', 'ui-dialog-body ui-scroll');
  const navigation = element('div', 'ui-calendar-nav');
  const previous = button('Previous');
  previous.setAttribute('aria-label', 'Previous month');
  const month = element('div', 'ui-calendar-month');
  month.id = id + '-month';
  month.setAttribute('aria-live', 'polite');
  const next = button('Next');
  next.setAttribute('aria-label', 'Next month');
  navigation.append(previous, month, next);
  const grid = element('div', 'ui-calendar');
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-labelledby', month.id);
  const hint = element(
    'p',
    'ui-sr-only',
    'Use arrow keys for days, Home and End for the week, Page Up and Page Down for months. Enter selects a date.',
  );
  hint.id = id + '-hint';
  grid.setAttribute('aria-describedby', hint.id);
  const footer = element('footer', 'ui-dialog-footer');
  const today = button('Today');
  footer.append(today);
  body.append(navigation, grid, hint);
  dialog.append(header, body, footer);
  root.append(dialog);
  const controller = createDialog(dialog, {
    initialFocus: () => focusedDate,
    returnFocus: () => options.returnFocus?.() || trigger,
  });
  const validate = (showError = true) => {
    let message = '';
    const value = input.value;
    if (value && !parseLocalDate(value)) {
      message = 'Enter a valid date using YYYY-MM-DD.';
    } else if (value && (value < minimum || value > maximum)) {
      message = 'Choose a date from ' + minimum + ' to ' + maximum + '.';
    }
    input.setCustomValidity(message);
    if (showError) {
      input.setAttribute('aria-invalid', String(!input.validity.valid));
    }
    return input.validity.valid;
  };
  const select = (value) => {
    input.value = value;
    validate();
    controller.close('selected');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const render = (moveFocus = false) => {
    activeDate = clamp(activeDate);
    const activeValue = formatLocalDate(activeDate);
    const selectedValue = input.value;
    const year = activeDate.getFullYear();
    const monthIndex = activeDate.getMonth();
    month.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
      activeDate,
    );
    previous.disabled = activeValue.slice(0, 7) <= minimum.slice(0, 7);
    next.disabled = activeValue.slice(0, 7) >= maximum.slice(0, 7);
    grid.replaceChildren();
    const weekdayRow = element('div', 'ui-calendar-row');
    weekdayRow.setAttribute('role', 'row');
    for (let index = 0; index < 7; index++) {
      const day = new Date(2001, 0, 1 + index, 12);
      const label = element(
        'span',
        'ui-weekday',
        new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day),
      );
      label.setAttribute('role', 'columnheader');
      weekdayRow.append(label);
    }
    grid.append(weekdayRow);
    const first = new Date(activeDate);
    first.setDate(1);
    first.setDate(1 - ((first.getDay() + 6) % 7));
    for (let week = 0; week < 6; week++) {
      const row = element('div', 'ui-calendar-row');
      row.setAttribute('role', 'row');
      for (let index = 0; index < 7; index++) {
        const date = new Date(first);
        date.setDate(first.getDate() + week * 7 + index);
        const cell = button(String(date.getDate()), 'ui-day');
        cell.setAttribute('role', 'gridcell');
        cell.tabIndex = -1;
        const dateYear = date.getFullYear();
        if (dateYear < 1 || dateYear > 9999) {
          cell.disabled = true;
          row.append(cell);
          continue;
        }
        const value = formatLocalDate(date);
        cell.dataset.date = value;
        cell.disabled = value < minimum || value > maximum;
        cell.setAttribute(
          'aria-label',
          new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(date),
        );
        cell.setAttribute('aria-selected', String(value === selectedValue));
        if (date.getMonth() !== monthIndex || date.getFullYear() !== year) {
          cell.dataset.outside = 'true';
        }
        if (value === formatLocalDate(new Date())) {
          cell.setAttribute('aria-current', 'date');
        }
        if (value === activeValue) {
          cell.tabIndex = 0;
          focusedDate = cell;
        }
        row.append(cell);
      }
      grid.append(row);
    }
    const todayValue = formatLocalDate(new Date());
    today.disabled = todayValue < minimum || todayValue > maximum;
    if (moveFocus) {
      focusTarget(focusedDate);
    }
  };
  const open = () => {
    if (input.disabled || input.readOnly) {
      return;
    }
    activeDate = parseLocalDate(input.value) || new Date();
    render();
    controller.open(trigger);
    trigger.setAttribute('aria-expanded', 'true');
  };
  const closeDialog = () => controller.close();
  const closed = () => trigger.setAttribute('aria-expanded', String(dialog.open));
  const chooseToday = () => select(formatLocalDate(new Date()));
  const changeMonth = (amount) => {
    activeDate = shiftCalendarMonth(activeDate, amount);
    render(true);
  };
  const previousMonth = () => changeMonth(-1);
  const nextMonth = () => changeMonth(1);
  const gridClick = (event) => {
    const target = event.target;
    if (target instanceof HTMLButtonElement && target.dataset.date && !target.disabled) {
      select(target.dataset.date);
    }
  };
  const gridKeydown = (event) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.dataset.date) {
      return;
    }
    const date = parseLocalDate(target.dataset.date);
    if (!date) {
      return;
    }
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (Object.hasOwn(offsets, event.key)) {
      let offset = offsets[event.key];
      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        getComputedStyle(grid).direction === 'rtl'
      ) {
        offset = -offset;
      }
      date.setDate(date.getDate() + offset);
      activeDate = date;
    } else if (event.key === 'Home') {
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      activeDate = date;
    } else if (event.key === 'End') {
      date.setDate(date.getDate() + 6 - ((date.getDay() + 6) % 7));
      activeDate = date;
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      let step = 1;
      if (event.shiftKey) {
        step = 12;
      }
      if (event.key === 'PageUp') {
        step = -step;
      }
      activeDate = shiftCalendarMonth(date, step);
    } else {
      return;
    }
    event.preventDefault();
    render(true);
  };
  const changed = () => {
    if (validate()) {
      options.onChange?.(input.value);
    }
  };
  const clearError = () => {
    validate(false);
    input.removeAttribute('aria-invalid');
  };
  trigger.addEventListener('click', open);
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('close', closed);
  previous.addEventListener('click', previousMonth);
  next.addEventListener('click', nextMonth);
  today.addEventListener('click', chooseToday);
  grid.addEventListener('click', gridClick);
  grid.addEventListener('keydown', gridKeydown);
  input.addEventListener('change', changed);
  input.addEventListener('input', clearError);
  input.addEventListener('blur', validate);
  validate(false);
  return {
    open,
    close: closeDialog,
    validate,
    setDisabled(disabled) {
      input.disabled = Boolean(disabled);
      trigger.disabled = input.disabled || input.readOnly;
      if (trigger.disabled) {
        closeDialog();
      }
    },
    setBounds(bounds) {
      readBounds(bounds);
      validate();
      if (dialog.open) {
        render();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      controller.dispose();
      trigger.removeEventListener('click', open);
      close.removeEventListener('click', closeDialog);
      dialog.removeEventListener('close', closed);
      previous.removeEventListener('click', previousMonth);
      next.removeEventListener('click', nextMonth);
      today.removeEventListener('click', chooseToday);
      grid.removeEventListener('click', gridClick);
      grid.removeEventListener('keydown', gridKeydown);
      input.removeEventListener('change', changed);
      input.removeEventListener('input', clearError);
      input.removeEventListener('blur', validate);
      field.before(input);
      field.remove();
      dialog.remove();
    },
  };
}

export function confirmAction(options) {
  const root = options.root;
  if (!(root instanceof HTMLElement) || !root.isConnected || !root.matches('.ui')) {
    throw new TypeError('A confirmation needs the themed .ui root.');
  }
  const dialog = element('dialog', 'ui-dialog');
  const id = 'ui-confirm-' + ++nextPickerId;
  const heading = element('h2', '', options.title);
  heading.id = id;
  dialog.setAttribute('aria-labelledby', id);
  const header = element('header', 'ui-dialog-header');
  header.append(heading);
  const body = element('div', 'ui-dialog-body ui-scroll');
  const message = element('p', '', options.message);
  message.id = id + '-message';
  dialog.setAttribute('aria-describedby', message.id);
  body.append(message);
  const footer = element('footer', 'ui-dialog-footer');
  const cancel = button('Cancel');
  const confirm = button(options.confirmLabel || 'Confirm');
  confirm.dataset.variant = 'primary';
  footer.append(cancel, confirm);
  dialog.append(header, body, footer);
  root.append(dialog);
  const controller = createDialog(dialog, {
    initialFocus: () => cancel,
    returnFocus: options.returnFocus,
  });
  return new Promise((resolve) => {
    cancel.addEventListener('click', () => controller.close('cancel'));
    confirm.addEventListener('click', () => controller.close('confirmed'));
    dialog.addEventListener(
      'close',
      () => {
        const accepted = dialog.returnValue === 'confirmed';
        controller.dispose();
        dialog.remove();
        resolve(accepted);
      },
      { once: true },
    );
    controller.open(options.trigger);
  });
}
`;
