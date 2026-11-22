import { onCleanup } from 'solid-js';
import { createChime } from '../task-chime';

export function createTaskSound(): () => Promise<void> {
  const chime = createChime();
  onCleanup(chime.dispose);
  return () => chime.play().catch((error) => console.warn('Miter sound could not play.', error));
}
