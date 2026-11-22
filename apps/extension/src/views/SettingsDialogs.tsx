import type { WorkspaceController } from '../ui/workspace-controller';
import { Show } from 'solid-js';
import { WorkflowForm } from '../forms/WorkflowForm';
import { ProfileForm, SettingsForm } from '../forms';
import { ContextForm } from '../forms/ContextForm';
import { NotificationsForm, NotificationsSettings } from '../forms/NotificationsForm';
import { modelPickerResultSchema } from '../../../../packages/protocol/src/rpc';
import { callResult } from '../ui/rpc';

export function SettingsDialogs(props: { controller: WorkspaceController }) {
  const { snapshot, success, modal, setModal, notifications, project, rpc, playDing } = props.controller;
  const close = () => setModal('');

  return (
    <>
      <Show when={modal() === 'context'}>
        <ContextForm
          project={project}
          projects={() => snapshot().projects}
          rpc={rpc}
          close={close}
          success={success}
        />
      </Show>
      <Show when={modal() === 'notifications'}>
        <NotificationsForm
          preferences={notifications()}
          rpc={rpc}
          close={close}
          success={success}
          playSound={playDing}
        />
      </Show>
      <Show when={modal() === 'workflows' && project()?.id} keyed>
        {(projectId) => <WorkflowForm projectId={projectId} rpc={rpc} close={close} />}
      </Show>
      <Show when={modal() === 'profile' && project()}>
        {(capturedProject) => (
          <ProfileForm
            project={capturedProject()}
            projects={() => snapshot().projects}
            close={close}
            success={success}
            save={async (request) => {
              await rpc('project.profile', request);
            }}
          />
        )}
      </Show>
      <Show when={modal() === 'settings'}>
        <SettingsForm
          settings={snapshot().settings}
          close={close}
          pickModel={() => callResult(rpc, modelPickerResultSchema, 'settings.pickModel')}
          notifications={(closeNotifications) => (
            <NotificationsSettings
              rpc={rpc}
              close={closeNotifications}
              success={success}
              playSound={playDing}
            />
          )}
          save={async (request) => {
            await rpc('settings.update', request);
            success('Settings saved.');
          }}
        />
      </Show>
    </>
  );
}
