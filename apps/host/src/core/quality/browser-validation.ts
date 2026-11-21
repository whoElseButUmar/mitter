/** Called in a disposable baseline document after its screenshot has been captured. */
export function checkNativeValidation(): string[] {
  const findings: string[] = [];
  const visible = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return (
      element.getClientRects().length > 0 && style.visibility === 'visible' && !element.closest('[inert]')
    );
  };

  let checked = 0;
  for (const form of Array.from(document.forms).slice(0, 16)) {
    if (!form.closest('.ui') || form.noValidate) {
      continue;
    }
    const controls = Array.from(form.elements);
    const missing = controls.filter(
      (control) =>
        (control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement) &&
        control.willValidate &&
        control.validity.valueMissing &&
        visible(control),
    );
    const submitter = controls.find(
      (control) =>
        (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) &&
        control.type === 'submit' &&
        !control.formNoValidate &&
        !control.matches(':disabled') &&
        visible(control),
    );
    if (!missing.length || !(submitter instanceof HTMLElement)) {
      continue;
    }

    // Reading validity.valueMissing above does not fire invalid. Observe the actual
    // activation and let application listeners cancel either it or each invalid event.
    const invalid: Event[] = [];
    const clicks: Event[] = [];
    const onInvalid = (event: Event) => {
      if (event.isTrusted && event.cancelable && missing.some((field) => field === event.target)) {
        invalid.push(event);
      }
    };
    const onClick = (event: Event) => {
      if (event.target === submitter) {
        clicks.push(event);
      }
    };
    window.addEventListener('invalid', onInvalid, true);
    window.addEventListener('click', onClick, true);
    try {
      submitter.click();
    } finally {
      window.removeEventListener('invalid', onInvalid, true);
      window.removeEventListener('click', onClick, true);
    }
    if (clicks.some((click) => !click.defaultPrevented) && invalid.some((event) => !event.defaultPrevented)) {
      let target = 'Form';
      if (form.id) {
        target = '#' + form.id.slice(0, 80);
      }
      findings.push(
        target +
          ' shows browser-native validation on empty submit. Show a styled field error, associate it with the input and focus the first invalid control. Keep required fields and server-side validation.',
      );
    }
    checked++;
    if (checked === 4) {
      break;
    }
  }
  return findings;
}
