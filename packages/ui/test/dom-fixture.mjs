// A deliberately small DOM/lifecycle fixture, not a browser or a production DOM implementation.
// Tests exercise controllers; layout, top-layer painting and the accessibility tree need a browser.
class FixtureTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event) {
    Object.defineProperty(event, 'target', { value: this, configurable: true });
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      listener(event);
    }
    return true;
  }
  async emit(type, properties = {}) {
    const event = {
      type,
      target: this,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {},
      ...properties,
    };
    const pending = [...(this.listeners.get(type) || [])].map((listener) => listener(event));
    pending.push(this['on' + type]?.(event));
    await Promise.all(pending);
    return event;
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((count, values) => count + values.size, 0);
  }
}

class FixtureNode extends FixtureTarget {
  children = [];
  parentElement = null;
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  get isConnected() {
    return this === this.ownerDocument?.body || !!this.parentElement?.isConnected;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  replaceWith(node) {
    const parent = this.parentElement;

    if (parent) {
      parent.insertBefore(node, this);
      this.remove();
    }
  }
  after(node) {
    const parent = this.parentElement;
    if (!parent) {
      return;
    }
    node.remove();
    const index = parent.children.indexOf(this);
    node.parentElement = parent;
    parent.children.splice(index + 1, 0, node);
  }
  insertBefore(node, current) {
    node.remove();
    node.parentElement = this;
    const index = this.children.indexOf(current);
    if (index < 0) {
      this.children.push(node);
    } else {
      this.children.splice(index, 0, node);
    }
  }
}

class FixtureElement extends FixtureNode {
  attributes = new Map();
  dataset = {};
  hidden = false;
  disabled = false;
  required = false;
  id = '';
  className = '';
  scrollHeight = 100;
  scrollTop = 0;
  style = {};
  _text = '';
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.classList = {
      add: (name) => {
        this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' ');
      },
      remove: (name) => {
        this.className = this.className
          .split(' ')
          .filter((value) => value !== name)
          .join(' ');
      },
      toggle: (name, on) => {
        if (on) {
          this.classList.add(name);
        } else {
          this.classList.remove(name);
        }
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') {
      this.id = String(value);
    }
    if (name === 'class') {
      this.className = String(value);
    }
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] =
        String(value);
    }
    if (['hidden', 'disabled', 'required'].includes(name)) {
      this[name] = true;
    }
    if (['name', 'type', 'value'].includes(name)) {
      this[name] = value;
    }
  }
  getAttribute(name) {
    if (name === 'id' && this.id) {
      return this.id;
    }
    if (name === 'class' && this.className) {
      return this.className;
    }
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      return this.dataset[key] ?? null;
    }

    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.getAttribute(name) !== null || (name === 'disabled' && this.disabled);
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.replaceChildren();
    this._text = String(value ?? '');
  }
  set innerHTML(source) {
    this.replaceChildren();
    const stack = [this];
    const voidTags = new Set(['input', 'img', 'meta', 'link', 'source', 'br', 'base', 'embed']);
    for (const token of source.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) {
        stack.pop();
        continue;
      }
      const parent = stack.at(-1);
      if (token.startsWith('<')) {
        const tag = /^<([a-z][\w-]*)/i.exec(token)?.[1];
        if (!tag || !parent) {
          continue;
        }
        const node = this.ownerDocument.createElement(tag);
        for (const attribute of token.slice(tag.length + 1, -1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
          node.setAttribute(attribute[1], attribute[2] || '');
        }
        parent.append(node);
        if (!voidTags.has(tag) && !token.endsWith('/>')) {
          stack.push(node);
        }
      } else if (parent) {
        parent._text += token;
      }
    }
  }
  get innerHTML() {
    return '';
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      let pattern = part.trim();
      const not = /:not\(([^)]+)\)/.exec(pattern);
      if (not && this.matches(not[1])) {
        return false;
      }
      pattern = pattern.replace(/:not\([^)]+\)/g, '');
      if (pattern.includes(':disabled') && !this.disabled) {
        return false;
      }
      pattern = pattern.replace(':disabled', '');
      const tag = /^[a-z]+/i.exec(pattern)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) {
        return false;
      }
      for (const match of pattern.matchAll(/\.([\w-]+)/g)) {
        if (!this.className.split(' ').includes(match[1])) {
          return false;
        }
      }
      for (const match of pattern.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (!this.hasAttribute(match[1])) {
          return false;
        }
        if (match[2] !== undefined && this.getAttribute(match[1]) !== match[2]) {
          return false;
        }
      }
      return true;
    });
  }
  querySelectorAll(selector) {
    if (selector.startsWith(':scope > ')) {
      return this.children.filter((child) => child.matches(selector.slice(9)));
    }
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) {
    if (this.matches(selector)) {
      return this;
    }
    return this.parentElement?.closest(selector) || null;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  scrollIntoView() {
    this.scrolled = true;
  }
  click() {
    if (!this.disabled) {
      void this.emit('click');
    }
  }
  getClientRects() {
    if (this.isConnected) {
      return [{}];
    }
    return [];
  }
  getBoundingClientRect() {
    return { left: 20, right: 120, top: 20, bottom: 40, width: 100 };
  }
}

class FixtureHTMLElement extends FixtureElement {}
class FixtureButton extends FixtureHTMLElement {}
class FixtureLabel extends FixtureHTMLElement {}
class FixtureInput extends FixtureHTMLElement {
  value = '';
}
class FixtureOption extends FixtureHTMLElement {
  value = '';
  get text() {
    return this.textContent;
  }
}
class FixtureSelect extends FixtureHTMLElement {
  _selectedIndex = 0;
  validity = { valid: true };
  validationMessage = 'Choose an option.';
  get options() {
    return this.querySelectorAll('option');
  }
  get selectedIndex() {
    return this._selectedIndex;
  }
  set selectedIndex(index) {
    this._selectedIndex = index;
  }
  get selectedOptions() {
    return this.options.slice(this.selectedIndex, this.selectedIndex + 1);
  }
  get value() {
    return this.options[this.selectedIndex]?.value || '';
  }
  set value(value) {
    this._selectedIndex = this.options.findIndex((option) => option.value === value);
  }
  get form() {
    return this.closest('form');
  }
}
class FixtureForm extends FixtureHTMLElement {
  reportValidity() {
    return true;
  }
  requestSubmit() {
    void this.emit('submit');
  }
}
class FixtureFieldset extends FixtureHTMLElement {}
class FixtureDialog extends FixtureHTMLElement {}
class FixtureMedia extends FixtureHTMLElement {
  pause() {
    this.paused = true;
  }
}
class FixtureGroup extends FixtureHTMLElement {}
class FixtureFrame extends FixtureHTMLElement {
  contentWindow = {
    messages: [],
    postMessage(message, origin) {
      this.messages.push({ message, origin });
    },
  };
}

export function domFixture() {
  const observers = [];
  const frames = new Map();
  let frame = 0;
  const window = new FixtureTarget();
  Object.assign(window, {
    Node: FixtureNode,
    Element: FixtureElement,
    HTMLElement: FixtureHTMLElement,
    HTMLButtonElement: FixtureButton,
    HTMLLabelElement: FixtureLabel,
    HTMLInputElement: FixtureInput,
    HTMLSelectElement: FixtureSelect,
    HTMLFormElement: FixtureForm,
    HTMLFieldSetElement: FixtureFieldset,
    HTMLDialogElement: FixtureDialog,
    HTMLMediaElement: FixtureMedia,
    HTMLOptGroupElement: FixtureGroup,
    Event,
    MouseEvent: class extends Event {},
    innerWidth: 1000,
    innerHeight: 800,
    visualViewport: null,
    queueMicrotask,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    requestAnimationFrame(callback) {
      frame += 1;
      frames.set(frame, callback);
      return frame;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  });
  const document = new FixtureTarget();
  document.defaultView = window;
  document.activeElement = null;
  document.hidden = false;
  document.createElement = (tag) => {
    const constructors = {
      button: FixtureButton,
      label: FixtureLabel,
      iframe: FixtureFrame,
      input: FixtureInput,
      textarea: FixtureInput,
      select: FixtureSelect,
      option: FixtureOption,
      form: FixtureForm,
      fieldset: FixtureFieldset,
      dialog: FixtureDialog,
      audio: FixtureMedia,
      video: FixtureMedia,
      optgroup: FixtureGroup,
    };
    const Constructor = constructors[tag] || FixtureHTMLElement;
    return new Constructor(document, tag);
  };
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
  document.body = document.createElement('body');
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  document.getSelection = () => null;
  const root = document.createElement('div');
  document.body.append(root);
  return { document, window, root, observers, frames };
}
