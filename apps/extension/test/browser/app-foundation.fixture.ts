import { APP_FOUNDATION_CSS } from '../../../../packages/protocol/src/task-skills/app-design';

/** The only component styling in this shadow root is the CSS bundled into task prompts. */
export function createAppFoundationFixture() {
  let frame: HTMLIFrameElement | undefined;
  let host: HTMLDivElement | undefined;
  let shadow: ShadowRoot | undefined;
  let scrollViewport: HTMLElement | undefined;
  let scrollCompletions = 0;
  const scrolled = () => {
    scrollCompletions++;
  };

  function dispose() {
    scrollViewport?.removeEventListener('scrollend', scrolled);
    scrollViewport = undefined;
    scrollCompletions = 0;
    frame?.remove();
    frame = undefined;
    host?.remove();
    host = undefined;
    shadow = undefined;
  }

  function element(id: string) {
    const found = shadow?.getElementById(id) ?? frame?.contentDocument?.getElementById(id);
    if (!found) {
      throw new Error('Missing app foundation fixture element: ' + id);
    }
    return found;
  }

  function mountFrame() {
    dispose();
    frame = document.createElement('iframe');
    frame.id = 'app-foundation-fixture';
    frame.title = 'Isolated app foundation check';
    frame.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;border:0!important;' +
      'inline-size:100vw!important;block-size:100vh!important;z-index:2147483647!important;';
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    if (!frameDocument?.body) {
      throw new Error('The app foundation fixture requires its same-origin blank document.');
    }
    frameDocument.documentElement.style.fontSize = '16px';
    return frameDocument;
  }

  function mount() {
    const frameDocument = mountFrame();
    host = document.createElement('div');
    shadow = host.attachShadow({ mode: 'open' });
    const layout = document.createElement('style');
    layout.textContent = `
      :host { all:initial!important; display:block!important; position:fixed!important;
        inset:0!important; z-index:2147483647!important; overflow:auto!important; background:white!important; }
      .fixture-layout { padding:16px; max-inline-size:480px; }
      form { display:grid; gap:8px; }
      .fixture-actions { display:flex; gap:8px; }
      .fixture-scroll { block-size:72px; }
      .fixture-motion { animation:fixture-pulse 1s linear infinite; transition:opacity 1s; scroll-behavior:smooth; }
      @keyframes fixture-pulse { from { opacity:1; } to { opacity:.99; } }
    `;
    const foundation = document.createElement('style');
    foundation.id = 'foundation-css';
    foundation.textContent = APP_FOUNDATION_CSS;
    const content = document.createElement('section');
    content.className = 'ui fixture-layout';
    content.id = 'theme';
    content.innerHTML = `
      <form id="form">
        <div class="fixture-actions">
          <button id="previous" type="button" class="ui-button">Previous</button>
          <button id="primary" type="button" class="ui-button" data-variant="primary">Save</button>
          <button id="disabled" type="button" class="ui-button" disabled>Disabled</button>
        </div>
        <label for="title">Title</label>
        <input id="title" class="ui-control" name="title" autocomplete="name" required minlength="3">
        <label for="category">Category</label>
        <div class="ui-select" id="select-wrap">
          <select id="category" class="ui-control" name="category">
            <option value="active">Active</option><option id="archive-option" value="archive">Archive</option>
          </select>
        </div>
        <label for="error">Reference</label>
        <input id="error" class="ui-control" aria-invalid="true" aria-describedby="error-text">
        <span id="error-text" class="ui-error">Check the reference.</span>
        <div class="ui-popup" id="popup">
          <div class="ui-calendar" aria-label="Example dates">
            <button type="button" class="ui-day" id="selected-day" aria-pressed="true">1</button>
            <button type="button" class="ui-day" aria-pressed="false">2</button>
            <button type="button" class="ui-day" aria-pressed="false">3</button>
            <button type="button" class="ui-day" aria-pressed="false">4</button>
            <button type="button" class="ui-day" aria-pressed="false">5</button>
            <button type="button" class="ui-day" aria-pressed="false">6</button>
            <button type="button" class="ui-day" aria-pressed="false">7</button>
          </div>
        </div>
        <div class="ui-scroll fixture-scroll" id="scroll" role="region" aria-label="History" tabindex="0">
          <p>First entry</p><p>Second entry</p><p>Third entry</p><p>Fourth entry</p><p>Last entry</p>
        </div>
        <span id="motion" class="fixture-motion">Motion preference check</span>
      </form>
    `;
    shadow.append(layout, foundation, content);
    frameDocument.body.append(host);
    scrollViewport = element('scroll');
    scrollViewport.addEventListener('scrollend', scrolled);
  }

  function mountScrollTable() {
    const frameDocument = mountFrame();
    // about:blank starts in quirks mode, whose root geometry can mask body overflow.
    frameDocument.open();
    frameDocument.write('<!doctype html><html><head></head><body></body></html>');
    frameDocument.close();
    const foundation = document.createElement('style');
    foundation.id = 'foundation-css';
    foundation.textContent = APP_FOUNDATION_CSS;
    const layout = document.createElement('style');
    layout.textContent = `
      body { margin:0; padding:12px; }
      table { inline-size:720px; table-layout:fixed; border-collapse:collapse; }
      th, td { padding:12px; text-align:start; }
    `;
    const viewport = document.createElement('section');
    viewport.id = 'table-scroll';
    viewport.className = 'ui-scroll';
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', 'Equipment inventory');
    viewport.innerHTML = `
      <table>
        <thead><tr><th scope="col">Equipment</th><th scope="col">Quantity</th>
          <th scope="col" id="table-actions"><span class="ui-sr-only" id="table-actions-label">Actions</span></th>
        </tr></thead>
        <tbody><tr><td>Camera</td><td>2</td><td><button class="ui-button" type="button">Edit camera</button></td></tr></tbody>
      </table>
    `;
    frameDocument.head.append(foundation, layout);
    frameDocument.body.className = 'ui';
    frameDocument.body.append(viewport);
  }

  function scrollTableState() {
    const frameDocument = frame?.contentDocument;
    if (!frameDocument) {
      throw new Error('The scroll table fixture is not mounted.');
    }
    const viewport = element('table-scroll');
    const label = element('table-actions-label');
    const labelBox = label.getBoundingClientRect();
    return {
      exactCSS: element('foundation-css').textContent === APP_FOUNDATION_CSS,
      mode: frameDocument.compatMode,
      documentWidth: frameDocument.documentElement.clientWidth,
      documentScrollWidth: frameDocument.documentElement.scrollWidth,
      documentOverflow: getComputedStyle(frameDocument.documentElement).overflowX,
      bodyOverflow: getComputedStyle(frameDocument.body).overflowX,
      viewportWidth: viewport.clientWidth,
      viewportScrollWidth: viewport.scrollWidth,
      scrollLeft: viewport.scrollLeft,
      labelWidth: labelBox.width,
      labelHeight: labelBox.height,
      labelClipPath: getComputedStyle(label).clipPath,
    };
  }

  function point(id: string) {
    const target = element(id);
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = target.getBoundingClientRect();
    const frameBox = frame?.getBoundingClientRect();
    if (!frameBox) {
      throw new Error('The app foundation frame was removed before pointer input.');
    }
    return { x: frameBox.left + box.left + box.width / 2, y: frameBox.top + box.top + box.height / 2 };
  }

  function inspect(id: string, pseudo = '') {
    const target = element(id);
    const style = getComputedStyle(target, pseudo);
    const box = target.getBoundingClientRect();
    return {
      id,
      focused: shadow?.activeElement === target,
      focusVisible: target.matches(':focus-visible'),
      outline: { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor },
      background: style.backgroundColor,
      color: style.color,
      border: style.borderColor,
      opacity: style.opacity,
      cursor: style.cursor,
      boxShadow: style.boxShadow,
      appearance: style.appearance,
      left: style.left,
      right: style.right,
      paddingInlineEnd: style.paddingInlineEnd,
      overflow: style.overflowY,
      scrollbarWidth: style.scrollbarWidth,
      scrollbarColor: style.scrollbarColor,
      transition: style.transitionDuration,
      animation: style.animationName,
      scrollBehavior: style.scrollBehavior,
      width: box.width,
      clientWidth: target.clientWidth,
      scrollWidth: target.scrollWidth,
      clientHeight: target.clientHeight,
      scrollHeight: target.scrollHeight,
      scrollTop: target.scrollTop,
    };
  }

  function state() {
    const form = element('form');
    const title = element('title');
    const category = element('category');
    if (
      !(form instanceof HTMLFormElement) ||
      !(title instanceof HTMLInputElement) ||
      !(category instanceof HTMLSelectElement)
    ) {
      throw new Error('The foundation fixture must retain native form controls.');
    }
    const values = new FormData(form);
    return {
      mounted: host?.isConnected === true,
      isolated: shadow?.host === host,
      exactCSS: element('foundation-css').textContent === APP_FOUNDATION_CSS,
      title: title.value,
      titleValue: values.get('title'),
      category: category.value,
      categoryValue: values.get('category'),
      valid: form.checkValidity(),
      pickerSupported:
        CSS.supports('appearance', 'base-select') && CSS.supports('selector(::picker(select))'),
      pickerOpen: category.matches(':open'),
      forcedColors: matchMedia('(forced-colors: active)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      viewportWidth: innerWidth,
    };
  }

  function direction(value: string) {
    if (value !== 'ltr' && value !== 'rtl') {
      throw new Error('The fixture direction must be ltr or rtl.');
    }
    element('theme').dir = value;
  }

  return {
    mount,
    mountScrollTable,
    scrollTableState,
    dispose,
    point,
    inspect,
    state,
    direction,
    scrollCompletions: () => scrollCompletions,
  };
}
