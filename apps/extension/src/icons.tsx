import type { JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import {
  AppWindow,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eraser,
  ExternalLink,
  FileText,
  Folder,
  History,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RotateCw,
  Settings,
  Square,
  Terminal,
  X,
} from 'lucide-solid';

export function Mark(props: { size?: number }) {
  return (
    <svg
      width={props.size ?? 30}
      height={props.size ?? 30}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      tabIndex={-1}
    >
      <path d="M5 30V9l15 13L35 9v21h-7V24l-8 7-8-7v6H5Z" fill="currentColor" />
    </svg>
  );
}

const icons = {
  app: AppWindow,
  bell: Bell,
  check: Check,
  close: X,
  copy: Copy,
  clear: Eraser,
  down: ChevronDown,
  external: ExternalLink,
  file: FileText,
  folder: Folder,
  history: History,
  pick: MousePointer2,
  pause: Pause,
  play: Play,
  plus: Plus,
  restart: RotateCw,
  right: ChevronRight,
  settings: Settings,
  stop: Square,
  terminal: Terminal,
};

export function Icon(props: { name: keyof typeof icons }): JSX.Element {
  return (
    <Dynamic
      component={icons[props.name]}
      class="miter-icon"
      size={16}
      strokeWidth={2}
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
