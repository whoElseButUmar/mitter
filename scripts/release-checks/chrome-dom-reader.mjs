import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  domReaderScenarioNameSchema,
  domReaderPlanSchema,
  domReaderObservationSchema,
  domReaderPageObservationSchema,
  domReaderReadResultSchema,
  domReaderControlSchema,
} from '../../apps/extension/test/browser/dom-reader-contracts.ts';
import { parseContract } from '../helpers/runtime.mjs';
import { evaluate, waitFor, page } from './chrome-ui.mjs';
import { waitConditionSchema, extensionIdSchema, targetCloseSchema } from './chrome-schemas.mjs';
import { openDomReaderOfflinePage } from './chrome-dom-reader-offline.mjs';
import { DOM_READER_PAGE_SOURCE } from './chrome-dom-reader-page.mjs';
import { withPreviewFrame } from './chrome-preview.mjs';

const reader = 'window.mitterReleaseFixture.domReader';
const priorUserId = 'reader-user-prior';
const currentUserId = 'reader-user-current';
const laterUserId = 'reader-user-later';
const digestCandidateScenarios = new Set([
  'digest-duplicate-before-user',
  'digest-earlier-user-receipt',
  'digest-later-known-user',
]);
const digestScenarios = new Set([
  'digest-dom-mutation',
  'digest-assistant-progress',
  ...digestCandidateScenarios,
  'digest-stop',
  'digest-session-replacement',
]);

// One result per scenario, a follow-up for each candidate mutation, and fresh,
// established, and stopped-session probe observations.
export const DOM_READER_EVIDENCE_LIMIT =
  domReaderScenarioNameSchema.options.length + digestCandidateScenarios.size + 3;

export const domReaderEvidenceSchema = z
  .strictObject({
    scenario: domReaderScenarioNameSchema,
    phase: z
      .enum(['inspection', 'held', 'refresh', 'probe'])
      .describe('The ordinary read, held completion, fresh follow-up, or read-only probe being recorded.'),
    result: domReaderReadResultSchema,
  })
  .describe('One named production-transport regression result, without raw provider or fixture bodies.');

export const domReaderEvidenceListSchema = z
  .array(domReaderEvidenceSchema)
  .max(DOM_READER_EVIDENCE_LIMIT)
  .describe(
    'Bounded scenario results, candidate-mutation follow-ups, and three read-only probe observations.',
  );

async function readerEvaluate(chrome, session, expression, label, contextId = undefined) {
  try {
    return await evaluate(chrome, session, expression, contextId);
  } catch (error) {
    // The shared evaluator includes its expression in errors. A mount carries
    // synthetic message bodies, so never expose that expression in release logs.
    throw new Error('Offline DOM-reader action failed: ' + label, { cause: error });
  }
}

export function assertDomReaderObservation(raw) {
  const view = domReaderObservationSchema.parse(raw);
  const label = view.scenario;
  const conflict = label === 'receipt-role-conflict';
  const differentUser = label === 'different-known-user' || label === 'iframe-only-receipt';
  let expectedLastUser = currentUserId;
  if (conflict) {
    expectedLastUser = priorUserId;
  } else if (
    label === 'later-known-user' ||
    label === 'different-known-user' ||
    label === 'digest-later-known-user'
  ) {
    expectedLastUser = laterUserId;
  }
  assert.equal(view.lastUserId, expectedLastUser, label + ': preserve the latest known user identity');
  assert.equal(view.userIds[0], priorUserId, label + ': preserve the prior user identity');
  assert.equal(view.transcriptUsers, view.userCount, label + ': retain consistent user counts');
  assert.equal(view.transcriptAssistants >= 1, true, label + ': retain the prior assistant turn');
  assert.equal(view.stopped, false, label + ': inspection does not stop its session');
  assert.equal(view.userExact, !conflict, label + ': preserve the complete visible latest-user candidate');
  assert.equal(view.history.length, 1, label + ': retain task-turn history');
  let expectedHistory = 2;
  if (conflict || differentUser || label === 'digest-earlier-user-receipt') {
    expectedHistory = 1;
  }
  assert.equal(view.history[0]?.count, expectedHistory, label + ': do not replace prior task history');
  assert.equal(view.history[0]?.workerId, 'reader_worker', label + ': preserve history task identity');
  assert.equal(view.history[0]?.projectId, 'reader_project', label + ': preserve history project identity');

  if (label === 'complete-roleless' || label === 'complete-roleless-copy-code') {
    assert.equal(view.count, 4, label + ': retain both prior turns and the current adjacent pair');
    assert.equal(view.userCount, 2, label + ': do not replace recognized user history');
    assert.deepEqual(view.userIds, [priorUserId, currentUserId]);
    assert.equal(view.lastRole, 'assistant');
    assert.equal(view.receiptState, 'matched');
    assert.equal(view.receiptMatches, 1);
    assert.equal(view.responseControls, 2);
    assert.equal(view.unclassifiedTail, false);
    assert.equal(view.unknownTurns, 0);
    assert.equal(view.busy, false);
    assert.equal(view.complete, true);
    assert.equal(view.assistantExact, true, label + ': preserve literal source bytes');
    assert.equal(view.assistantFormat, 'code');
    assert.equal(view.assistantIssue, null);
    assert.equal(view.codeReply, true, label + ': exercise the correlated code fast lane too');
    assert.equal(view.codeExact, true);
    assert.equal(view.copyControl, label === 'complete-roleless-copy-code');
    assert.equal(view.receiptMatched, true);
    return;
  }

  assert.equal(view.complete, false, label + ': unresolved content cannot prove a complete response');
  assert.equal(view.assistantCharacters, 0, label + ': do not cherry-pick a reply across a barrier');
  assert.equal(view.assistantExact, false);
  assert.equal(view.unclassifiedTail, true, label + ': preserve unknown tail evidence');
  assert.equal(view.unknownTurns >= 1, true, label + ': retain unknown turn barriers');
  if (label === 'scan-limit') {
    assert.equal(view.scanLimited, true);
    assert.equal(view.codeIssue, 'SCAN_LIMIT');
    return;
  }
  assert.equal(view.scanLimited, false);
  assert.notEqual(view.receiptState, null, label + ': do not skip fallback for a mixed-role tail');
  if (
    label === 'mixed-generating' ||
    label === 'mixed-generating-correlated' ||
    label === 'copy-only' ||
    label === 'digest-assistant-progress'
  ) {
    assert.equal(view.receiptState, 'waiting_reply', label + ': require waiting proof from the full receipt');
    assert.equal(view.receiptMatches, 1);
    assert.equal(view.receiptMatched, true);
    assert.equal(view.responseControls, 0);
    assert.equal(view.lastRole, 'unknown');
    assert.equal(view.count, 4);
    assert.equal(view.userCount, 2);
    assert.deepEqual(view.userIds, [priorUserId, currentUserId]);
    assert.equal(view.busy, label !== 'copy-only');
    if (label === 'digest-assistant-progress') {
      assert.equal(view.unknownTurns, 1);
      assert.equal(view.transcriptAssistants, 1);
      assert.equal(view.codeReply, false);
      assert.equal(view.copyControl, false);
    }
    if (label === 'mixed-generating-correlated' || label === 'copy-only') {
      assert.equal(view.codeReply, true, label + ': Copy code/nonce must not bypass tail classification');
      assert.equal(view.codeExact, true);
      assert.equal(view.copyControl, true);
    }
  } else if (
    label === 'duplicate-receipt' ||
    label === 'digest-duplicate-before-user' ||
    label === 'digest-earlier-user-receipt'
  ) {
    assert.equal(view.receiptState, 'ambiguous');
    assert.equal(view.receiptMatches, 2);
    let expectedCount = 5;
    if (label === 'digest-earlier-user-receipt') {
      expectedCount = 4;
    }
    assert.equal(view.count, expectedCount, label + ': retain every current turn without promoting a reply');
    assert.equal(view.userCount, 2);
    assert.deepEqual(view.userIds, [priorUserId, currentUserId]);
    assert.equal(view.receiptMatched, true);
  } else if (label === 'later-known-user' || label === 'digest-later-known-user') {
    assert.equal(view.receiptState, 'unknown_tail');
    assert.equal(view.receiptMatches, 1);
    assert.equal(view.count, 6);
    assert.equal(view.userCount, 3);
    assert.deepEqual(view.userIds, [priorUserId, currentUserId, laterUserId]);
    assert.equal(view.receiptMatched, false);
    assert.equal(view.codeReply, false);
    assert.equal(view.codeIssue, 'NEWER_USER_MESSAGE');
  } else if (label === 'mismatched-receipt' || label === 'edited-receipt' || differentUser || conflict) {
    assert.equal(view.receiptMatches, 0, label + ': a marker or stable ID is not a full receipt match');
    assert.equal(view.receiptMatched, false);
  } else {
    assert.equal(
      view.receiptState,
      'unknown_tail',
      label + ': preserve substantive or role-conflict barriers',
    );
    assert.equal(view.receiptMatches, 1);
    if (label === 'multiple-unknown-branches' || label === 'unknown-later-branch') {
      assert.equal(view.count, 5);
    }
    if (label === 'unknown-intervening-branch') {
      assert.equal(view.tailBranches, 2, 'Do not skip a substantive branch without turn metadata.');
    }
  }
}

export function assertDomReaderInvalidatedRead(raw) {
  const view = domReaderObservationSchema.parse(raw);
  const label = view.scenario;
  const currentBodyChanged = label === 'digest-dom-mutation';
  const laterUserInserted = label === 'digest-later-known-user';
  assert.equal(
    currentBodyChanged || digestCandidateScenarios.has(label),
    true,
    'Only a held DOM-mutation result may be checked as discarded receipt proof.',
  );
  assert.equal(view.operation, 'inspect');
  assert.equal(view.complete, false, label + ': discard stale completion proof');
  assert.equal(view.assistantCharacters, 0, label + ': do not expose a reply from a stale candidate set');
  assert.equal(view.assistantExact, false);
  let expectedMatches = 0;
  if (laterUserInserted) {
    // The earlier receipt body is unchanged and still matches once. That count
    // cannot authorize waiting or completion after a newer known user appears.
    expectedMatches = 1;
  }
  assert.equal(view.receiptMatches, expectedMatches, label + ': retain accurate body-match diagnostics');
  assert.equal(view.responseControls, 0);
  assert.notEqual(view.receiptState, 'matched');
  assert.notEqual(view.receiptState, 'waiting_reply');
  assert.equal(view.unclassifiedTail, true, label + ': retain the unknown response barrier');
  assert.equal(view.unknownTurns >= 1, true);
  assert.equal(view.scanLimited, false);
  assert.equal(view.stopped, false);
  assert.equal(view.ready, true);
  assert.equal(view.lastRole, 'unknown');
  assert.equal(view.userExact, !currentBodyChanged);
  assert.equal(view.receiptMatched, !currentBodyChanged && !laterUserInserted);

  const expectedUserIds = [priorUserId, currentUserId];
  let expectedCount = 4;
  let expectedLastUserId = currentUserId;
  let expectedHistory = 2;
  if (label === 'digest-duplicate-before-user') {
    expectedCount = 5;
  } else if (label === 'digest-earlier-user-receipt') {
    expectedHistory = 1;
  } else if (laterUserInserted) {
    expectedUserIds.push(laterUserId);
    expectedCount = 6;
    expectedLastUserId = laterUserId;
  }
  assert.equal(view.count, expectedCount, label + ': refresh the current base transcript');
  assert.equal(view.userCount, expectedUserIds.length);
  assert.equal(view.transcriptUsers, expectedUserIds.length);
  assert.equal(view.transcriptAssistants, 1);
  assert.deepEqual(view.userIds, expectedUserIds, label + ': retain all current known user IDs');
  assert.equal(view.lastUserId, expectedLastUserId);
  assert.deepEqual(view.history, [
    { workerId: 'reader_worker', projectId: 'reader_project', count: expectedHistory },
  ]);
}

export async function grantDomReaderHostPermission(chrome, fixtureSession, rawExtensionId) {
  const { id } = extensionIdSchema.parse({ id: rawExtensionId });
  const declared = parseContract(
    waitConditionSchema,
    await readerEvaluate(
      chrome,
      fixtureSession,
      `location.protocol === 'chrome-extension:' && chrome.runtime.id === ${JSON.stringify(id)} && chrome.runtime.getManifest().optional_host_permissions?.includes('https://chatgpt.com/*') === true`,
      'verify the fixture extension and its declared optional ChatGPT origin',
    ),
    'The reader permission declaration check must return a boolean.',
  );
  assert.equal(declared, true, 'Do not grant undeclared origins or another extension access.');
  const settings = await page(chrome, 'chrome://extensions/');
  try {
    // Headless Chrome cannot accept the native optional-permission prompt. This
    // is the Extensions settings API, restricted by Chrome to requested hosts:
    // chrome/common/extensions/api/developer_private.webidl:addHostPermission.
    await readerEvaluate(
      chrome,
      settings.session,
      `chrome.developerPrivate.addHostPermission(${JSON.stringify(id)}, 'https://chatgpt.com/*')`,
      'grant only the declared ChatGPT host in this disposable profile',
    );
  } finally {
    parseContract(
      targetCloseSchema,
      await chrome.request('Target.closeTarget', { targetId: settings.targetId }),
      'Chrome did not close the disposable Extensions settings target.',
    );
  }
}

export async function checkDomReader(
  chrome,
  fixtureSession,
  extensionId,
  { onEvidence = async () => {}, scenarioNames = domReaderScenarioNameSchema.options } = {},
) {
  const deadline = Date.now() + 30000;
  const evidence = [];
  const checkDeadline = () => {
    if (Date.now() >= deadline) {
      throw new Error('Offline DOM-reader regressions exceeded their 30-second scheduling budget.');
    }
  };
  const record = async (scenario, result, phase = 'inspection') => {
    if (evidence.length >= DOM_READER_EVIDENCE_LIMIT) {
      throw new Error('Offline DOM-reader evidence exceeded its bounded observation limit.');
    }
    const item = domReaderEvidenceSchema.parse({ scenario, phase, result });
    evidence.push(item);
    await onEvidence(item);
  };
  const action = async (expression, label) => {
    checkDeadline();
    return readerEvaluate(chrome, fixtureSession, expression, label);
  };
  let offline;

  try {
    await grantDomReaderHostPermission(chrome, fixtureSession, extensionId);
    checkDeadline();
    const authorized = parseContract(
      waitConditionSchema,
      await action(reader + '.authorize()', 'authorize the existing optional ChatGPT origin'),
      'The disposable DOM-reader permission result must be a boolean.',
    );
    assert.equal(authorized, true, 'Grant only the existing optional origin in the disposable profile.');
    offline = await openDomReaderOfflinePage(chrome);
    await action(reader + '.connect()', 'connect the production page transport');
    await readerEvaluate(
      chrome,
      offline.target.session,
      DOM_READER_PAGE_SOURCE,
      'install the offline DOM builder',
    );
    const pageAction = (expression, label) => {
      checkDeadline();
      return readerEvaluate(chrome, offline.target.session, expression, label);
    };
    const pageState = async () =>
      parseContract(
        domReaderPageObservationSchema,
        await pageAction('window.mitterDomReaderPage.inspect()', 'inspect read-only DOM effects'),
        'Invalid real-DOM reader effects or isolation evidence.',
      );
    const control = async () =>
      parseContract(
        domReaderControlSchema,
        await action(reader + '.control()', 'read the independent session control channel'),
        'Invalid reader-session control evidence.',
      );

    for (const rawName of scenarioNames) {
      const name = domReaderScenarioNameSchema.parse(rawName);
      const plan = parseContract(
        domReaderPlanSchema,
        await action(`${reader}.prepare(${JSON.stringify(name)})`, 'prepare ' + name),
        'Invalid synthetic DOM-reader plan. Rebuild its feature fixture before retrying.',
      );
      const mount = async (input) =>
        pageAction(
          `window.mitterDomReaderPage.mount(${JSON.stringify(domReaderPlanSchema.parse(input))})`,
          'mount ' + name,
        );
      await mount(plan);
      if (name === 'iframe-only-receipt') {
        await waitFor(
          chrome,
          offline.target.session,
          'window.mitterDomReaderPage.inspect().frameOpaque === true',
          'opaque offline receipt decoy',
        );
        await withPreviewFrame(chrome, offline.target.session, 'about:srcdoc', async (session, contextId) => {
          const isolated = parseContract(
            waitConditionSchema,
            await readerEvaluate(
              chrome,
              session,
              `document.getElementById('reader-frame-decoy')?.textContent === ${JSON.stringify(plan.frameText)} && !globalThis.__mitterPageEndpointV4 && !globalThis.chrome?.runtime?.id`,
              'prove the exact decoy rendered without a bridge or extension API in the opaque iframe',
              contextId,
            ),
            'The opaque iframe decoy proof must return a boolean.',
          );
          assert.equal(
            isolated,
            true,
            'The inaccessible decoy must contain the full receipt, not a blocked document.',
          );
        });
      }
      if (name === 'mixed-generating') {
        await mount({ ...plan, draft: 'Keep this existing synthetic draft.\n' });
        const before = await pageState();
        const probe = domReaderObservationSchema.parse(
          await action(reader + '.observe("probe")', 'probe without a session'),
        );
        await record(name, { ok: true, observation: probe }, 'probe');
        assert.equal(
          probe.receiptState,
          null,
          'Probe must not run receipt fallback or establish waiting proof.',
        );
        assert.equal(probe.complete, false);
        assert.deepEqual(
          await pageState(),
          before,
          'Probe must not mutate DOM, click controls, or edit drafts.',
        );
        assert.equal(before.automationControls, 0, 'Probe must not install a Pause session.');
        assert.equal(
          before.mainWorldEndpoint,
          false,
          'The endpoint must exist only in the extension isolated world.',
        );
        await mount(plan);
      }

      if (digestScenarios.has(name)) {
        await action(reader + '.startHeldInspection()', 'hold real digest completion for ' + name);
        await waitFor(
          chrome,
          fixtureSession,
          `${reader}.gate().then((gate) => gate.held && gate.calls > 0)`,
          'real isolated-world digest completion',
        );
        checkDeadline();
        if (name === 'digest-dom-mutation') {
          await pageAction('window.mitterDomReaderPage.editCurrentUser()', 'edit the user DOM during digest');
        } else if (name === 'digest-assistant-progress') {
          const changed = parseContract(
            waitConditionSchema,
            await pageAction(
              'window.mitterDomReaderPage.advanceAssistantReasoning()',
              'advance only assistant reasoning during digest',
            ),
            'Assistant progress must return a user-body, identity, role, and membership preservation proof.',
          );
          assert.equal(changed, true, name + ': change reasoning text only, not receipt candidates');
        } else if (digestCandidateScenarios.has(name)) {
          const changed = parseContract(
            waitConditionSchema,
            await pageAction(
              'window.mitterDomReaderPage.mutateReceiptCandidates()',
              'change the candidate set during ' + name,
            ),
            'The held candidate mutation must return a byte-preservation proof.',
          );
          assert.equal(
            changed,
            true,
            name + ': change only the intended candidates and preserve receipt bytes',
          );
        } else if (name === 'digest-stop') {
          await action(reader + '.stop()', 'stop during digest');
        } else {
          await action(reader + '.replaceSession()', 'replace session during digest');
        }
        const result = domReaderReadResultSchema.parse(
          await action(reader + '.finishHeldInspection()', 'release ' + name),
        );
        await record(name, result, 'held');
        if (name === 'digest-assistant-progress') {
          assert.equal(result.ok, true, 'Assistant-only progress must retain unchanged user waiting proof.');
          if (result.ok) {
            assertDomReaderObservation(result.observation);
          }
        } else if (name === 'digest-dom-mutation' || digestCandidateScenarios.has(name)) {
          assert.equal(
            result.ok,
            true,
            'A changed DOM may be observed, but cannot retain stale receipt authority.',
          );
          if (result.ok) {
            assertDomReaderInvalidatedRead(result.observation);
          }
          if (digestCandidateScenarios.has(name)) {
            const refreshed = domReaderObservationSchema.parse(
              await action(reader + '.observe()', 'inspect the changed candidate set again for ' + name),
            );
            await record(name, { ok: true, observation: refreshed }, 'refresh');
            assertDomReaderObservation(refreshed);
          }
        } else {
          assert.deepEqual(result, { ok: false, code: 'STOPPED' }, name + ': fence the old in-flight read');
          const ownership = await control();
          assert.equal(ownership.ready, true);
          assert.equal(ownership.stopped, name === 'digest-stop');
          if (name === 'digest-stop') {
            const before = await pageState();
            const probe = domReaderObservationSchema.parse(
              await action(reader + '.observe("probe")', 'probe without adopting a stopped session'),
            );
            await record(name, { ok: true, observation: probe }, 'probe');
            assert.equal(probe.receiptState, null);
            assert.equal(probe.complete, false);
            assert.deepEqual(await pageState(), before);
            assert.deepEqual(await control(), { ready: true, stopped: true });
          }
        }
      } else {
        const observation = domReaderObservationSchema.parse(
          await action(reader + '.observe()', 'inspect ' + name),
        );
        await record(name, { ok: true, observation });
        assertDomReaderObservation(observation);
        if (name === 'mixed-generating') {
          const before = await pageState();
          const probe = domReaderObservationSchema.parse(
            await action(reader + '.observe("probe")', 'probe without replacing the established session'),
          );
          await record(name, { ok: true, observation: probe }, 'probe');
          assert.equal(probe.receiptState, null);
          assert.equal(probe.complete, false);
          assert.deepEqual(await pageState(), before);
          assert.deepEqual(await control(), { ready: true, stopped: false });
        }
      }
      const effects = await pageState();
      assert.equal(
        effects.clicks,
        0,
        name + ': inspection never clicks Stop, Copy code, Edit, or response controls',
      );
      assert.equal(effects.inputs, 0, name + ': inspection never changes the composer');
      assert.equal(effects.draftExact, true);
      assert.equal(effects.mainWorldEndpoint, false);
      assert.equal(effects.frameOpaque, true);
      assert.equal(effects.frames, Number(name === 'iframe-only-receipt'));
      offline.check();
    }
    return domReaderEvidenceListSchema.parse(evidence);
  } finally {
    try {
      await readerEvaluate(
        chrome,
        fixtureSession,
        reader + '.destroy()',
        'release the reader fixture and digest gate',
      );
    } finally {
      if (offline) {
        await offline.close();
      }
    }
  }
}
