import type { Settings } from '../../../../packages/protocol/src/index';
import { requireElement } from '../ui/dom';
import {
  mountModelSettingsForm,
  type ModelSettingsSave,
} from '../../../../packages/ui/src/model-settings-form';
import { createSignal, onMount, onCleanup, Show, type JSX } from 'solid-js';
import { Modal } from '../components';
import { TerminalAppearanceSettings } from '../components/TerminalAppearanceSettings';
import { Icon } from '../icons';

export function SettingsForm(props: {
  settings: Settings;
  close: () => void;
  save: (request: ModelSettingsSave) => Promise<void>;
  notifications: (close: () => void) => JSX.Element;
}) {
  const [busy, setBusy] = createSignal(false);
  const [terminalAppearance, setTerminalAppearance] = createSignal(false);
  const [notifications, setNotifications] = createSignal(false);

  let root: HTMLDivElement | undefined;
  let terminalAppearanceButton: HTMLButtonElement | undefined;
  let notificationsButton: HTMLButtonElement | undefined;
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

  const closeAppearance = () => {
    setTerminalAppearance(false);
    queueMicrotask(() => {
      if (terminalAppearanceButton?.isConnected) {
        terminalAppearanceButton.focus({ preventScroll: true });
      }
    });
  };

  const closeNotifications = () => {
    setNotifications(false);
    queueMicrotask(() => {
      if (notificationsButton?.isConnected) {
        notificationsButton.focus({ preventScroll: true });
      }
    });
  };

  return (
    <>
      <Modal title="Settings" close={props.close} closeDisabled={busy()}>
        <div class="settings-page">
          <section class="settings-section" aria-label="Appearance">
            <h3>Appearance</h3>
            <button
              ref={terminalAppearanceButton}
              type="button"
              class="settings-appearance settings-link"
              disabled={busy()}
              onClick={() => setTerminalAppearance(true)}
            >
              <Icon name="terminal" />
              <span class="settings-link-copy">
                <span>Terminal appearance</span>
                <small>Colors and fonts</small>
              </span>
              <Icon name="right" />
            </button>
          </section>
          <section class="settings-section" aria-label="Notifications">
            <h3>Notifications</h3>
            <button
              ref={notificationsButton}
              type="button"
              class="settings-notifications settings-link"
              disabled={busy()}
              onClick={() => setNotifications(true)}
            >
              <Icon name="bell" />
              <span class="settings-link-copy">
                <span>Desktop alerts</span>
              </span>
              <Icon name="right" />
            </button>
          </section>
          <div
            ref={(element) => {
              root = element;
            }}
          />
          <div class="button-row end settings-footer">
            <Show when={busy()}>
              <span role="status">Saving model settings…</span>
            </Show>
            <button type="button" disabled={busy()} onClick={props.close}>
              Done
            </button>
          </div>
        </div>
      </Modal>
      <Show when={terminalAppearance()}>
        <TerminalAppearanceSettings close={closeAppearance} />
      </Show>
      <Show when={notifications()}>{props.notifications(closeNotifications)}</Show>
    </>
  );
}
