import type { Settings } from '../../../../packages/protocol/src/index';
import { requireElement } from '../ui/dom';
import {
  mountModelSettingsForm,
  type ModelSettingsSave,
} from '../../../../packages/ui/src/model-settings-form';
import { createSignal, onMount, onCleanup } from 'solid-js';
import { Modal } from '../components';

export function SettingsForm(props: {
  settings: Settings;
  close: () => void;
  save: (request: ModelSettingsSave) => Promise<void>;
}) {
  const [busy, setBusy] = createSignal(false);

  let root: HTMLDivElement | undefined;
  let editor: ReturnType<typeof mountModelSettingsForm> | undefined;
  onMount(() => {
    editor = mountModelSettingsForm(requireElement(root, 'forms root'), {
      settings: props.settings,
      save: props.save,
      close: props.close,
      busyChanged: setBusy,
      reset: () => {
        props.close();
        window.dispatchEvent(new Event('miter-request-reset'));
      },
    });
  });

  onCleanup(() => editor?.dispose());

  return (
    <Modal title="Settings" close={props.close} closeDisabled={busy()}>
      <div
        ref={(element) => {
          root = element;
        }}
      />
    </Modal>
  );
}
