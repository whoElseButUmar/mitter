import type { JSX } from 'solid-js';
import { projectSchema } from '../../../../packages/protocol/src/index';
import { projectCreateParamsSchema, type ProjectCreateParams } from '../../../../packages/protocol/src/rpc';
import { ProjectForm } from '../../src/forms/ProjectForm';

/** Mounted production form with only the desktop picker and host acknowledgement controlled. */
export function createProjectFormFixture(mount: (component: () => JSX.Element) => void, close: () => void) {
  const requests: ProjectCreateParams[] = [];
  const choices: string[] = [];
  let completion: ((project: ReturnType<typeof projectSchema.parse>) => void) | undefined;
  let rejection: ((error: Error) => void) | undefined;
  let opened = 0;
  let cancelled = false;
  let pickerFailed = false;

  function mountCreate() {
    if (completion) {
      throw new Error('Finish the previous project creation before mounting another fixture.');
    }
    requests.length = 0;
    choices.length = 0;
    opened = 0;
    mount(() => (
      <ProjectForm
        initialMode="create"
        close={close}
        pick={async (purpose) => {
          choices.push(purpose || 'project');
          if (pickerFailed) {
            pickerFailed = false;
            throw new Error('Controlled picker failure.');
          }
          if (cancelled) {
            cancelled = false;
            return { cancelled: true };
          }
          return { cancelled: false, root: '/controlled/projects' };
        }}
        create={(fields) => {
          requests.push(projectCreateParamsSchema.parse(fields));
          return new Promise((resolve, reject) => {
            completion = resolve;
            rejection = reject;
          });
        }}
        save={async () => {
          throw new Error('This fixture must create its project through the explicit create operation.');
        }}
        opened={() => {
          opened++;
        }}
      />
    ));
  }

  function finish() {
    const resolve = completion;
    const fields = requests.at(-1);
    if (!resolve || !fields) {
      throw new Error('No project creation is awaiting acknowledgement.');
    }
    completion = undefined;
    rejection = undefined;
    resolve(
      projectSchema.parse({
        id: 'created_project',
        name: fields.name,
        root: fields.parentRoot + '/' + fields.folderName,
        profiles: [],
        revision: 0,
      }),
    );
  }

  function fail() {
    const reject = rejection;
    if (!reject) {
      throw new Error('No project creation is awaiting acknowledgement.');
    }
    completion = undefined;
    rejection = undefined;
    reject(new Error('Controlled creation failure.'));
  }

  return {
    mount: mountCreate,
    finish,
    fail,
    failPickerOnce: () => {
      pickerFailed = true;
    },
    cancelPickerOnce: () => {
      cancelled = true;
    },
    inspect: () => ({ requests, choices, opened, pending: completion !== undefined }),
  };
}
