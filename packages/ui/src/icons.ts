import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Ellipsis,
  FileText,
  Folder,
  Folders,
  Info,
  ListTodo,
  Plus,
  TriangleAlert,
  X,
} from 'lucide';

const icons = {
  check: Check,
  chevronDown: ChevronDown,
  folders: Folders,
  folder: Folder,
  fileText: FileText,
  listTodo: ListTodo,
  plus: Plus,
  close: X,
  more: Ellipsis,
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: CircleX,
};

/** Enhance template-rendered disclosures while keeping native keyboard behavior. */
export function addDisclosureMarkers(root: HTMLElement): void {
  for (const summary of root.querySelectorAll('summary')) {
    summary.classList.add('disclosure-summary');
    summary.insertBefore(createIcon(root.ownerDocument, 'chevronDown'), summary.firstChild);
  }
}

/** Controls can belong to an iframe or an isolated preview document. */
export function createIcon(document: Document, name: keyof typeof icons, className = ''): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const attributes = {
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'miter-icon',
  };

  if (className) {
    attributes.class += ' ' + className;
  }

  for (const [attribute, value] of Object.entries(attributes)) {
    svg.setAttribute(attribute, value);
  }

  for (const [tag, attributes] of icons[name]) {
    const element = document.createElementNS(namespace, tag);

    for (const [attribute, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        element.setAttribute(attribute, String(value));
      }
    }

    svg.append(element);
  }

  return svg;
}
