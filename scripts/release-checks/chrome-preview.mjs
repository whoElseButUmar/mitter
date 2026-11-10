import assert from 'node:assert/strict';
import { parseContract } from '../helpers/runtime.mjs';
import {
  previewFixtureSchema,
  previewFrameTreeSchema,
  previewProbeSchema,
  previewTargetsSchema,
  previewWorldSchema,
  sessionIdSchema,
} from './chrome-schemas.mjs';
import { evaluate, waitFor } from './chrome-ui.mjs';

// Sandboxed extension frames can be out of process. Attach only the exact
// fixture URL, and never grant the inspection world universal origin access.
export async function withPreviewFrame(chrome, parentSession, url, check) {
  const targets = parseContract(
    previewTargetsSchema,
    await chrome.request('Target.getTargets'),
    'Chrome did not return valid preview target identities.',
  ).targetInfos.filter((target) => target.type === 'iframe' && target.url === url);
  assert.ok(targets.length <= 1, 'The preview sandbox target must be unambiguous.');
  let attachedSession;
  let session = parentSession;

  try {
    const target = targets[0];
    if (target) {
      attachedSession = parseContract(
        sessionIdSchema,
        await chrome.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }),
        'Chrome did not return the preview sandbox debugging session.',
      ).sessionId;
      session = attachedSession;
      await chrome.request('Runtime.enable', {}, session);
      await chrome.request('Log.enable', {}, session);
    }

    const tree = parseContract(
      previewFrameTreeSchema,
      await chrome.request('Page.getFrameTree', {}, session),
      'Chrome did not return a valid preview sandbox frame tree.',
    ).frameTree;
    const frames = [tree.frame, ...(tree.childFrames ?? []).map((child) => child.frame)].filter(
      (frame) => frame.url === url,
    );
    assert.equal(frames.length, 1, 'The exact packaged preview sandbox frame must exist.');
    const frame = frames[0];
    assert.ok(frame);
    const world = parseContract(
      previewWorldSchema,
      await chrome.request(
        'Page.createIsolatedWorld',
        { frameId: frame.id, worldName: 'mitter-release-preview' },
        session,
      ),
      'Chrome did not return the unprivileged preview inspection world.',
    );

    await check(session, world.executionContextId);
  } finally {
    if (attachedSession !== undefined) {
      await chrome.request('Target.detachFromTarget', { sessionId: attachedSession });
    }
  }
}

const probeSource = `(() => {
  const state = { parentMessages: 0, foreignMessages: 0, foreignOrigin: '', installations: 0 };
  const receive = (event) => {
    if (event.source === parent) {
      state.parentMessages++;
    } else {
      state.foreignMessages++;
      state.foreignOrigin = event.origin;
    }
  };
  addEventListener('message', receive);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLIFrameElement) {
          state.installations++;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true });
  window.mitterPreviewProbe = {
    inspect() {
      const frame = document.querySelector('iframe');
      let html = '';
      let sandbox = '';
      let referrerPolicy = '';
      let title = '';
      if (frame instanceof HTMLIFrameElement) {
        html = frame.srcdoc;
        sandbox = frame.getAttribute('sandbox') ?? '';
        referrerPolicy = frame.referrerPolicy;
        title = frame.title;
      }
      return {
        ...state,
        frames: document.querySelectorAll('iframe').length,
        html, sandbox, referrerPolicy, title,
        nativeAccess: Boolean(globalThis.chrome?.runtime),
      };
    },
    destroy() {
      removeEventListener('message', receive);
      observer.disconnect();
      delete window.mitterPreviewProbe;
    },
  };
})()`;

async function inspectFixture(chrome, session) {
  return parseContract(
    previewFixtureSchema,
    await evaluate(chrome, session, 'window.mitterPreviewFixture.inspect()'),
    'Invalid preview regression fixture observations. Rebuild the disposable fixture before retrying.',
  );
}

async function inspectProbe(chrome, session, contextId) {
  return parseContract(
    previewProbeSchema,
    await evaluate(chrome, session, 'window.mitterPreviewProbe.inspect()', contextId),
    'Invalid packaged preview sandbox observations. Inspect the Chrome release-check log.',
  );
}

export async function checkPreviewSandbox(chrome, session, extensionId) {
  try {
    await waitFor(
      chrome,
      session,
      'typeof window.mitterPreviewFixture === "object"',
      'canonical preview fixture module',
    );
    await evaluate(chrome, session, 'window.mitterPreviewFixture.mount()');
    await waitFor(
      chrome,
      session,
      'window.mitterPreviewFixture.inspect().ready.length === 2',
      'packaged preview and opaque peer readiness',
    );
    const fixture = await inspectFixture(chrome, session);
    assert.deepEqual(fixture.ready.map((ready) => ready.frame).sort(), ['peer', 'preview']);
    assert.ok(
      fixture.ready.every((ready) => ready.origin === 'null'),
      'Both outer frames must be opaque.',
    );

    await withPreviewFrame(
      chrome,
      session,
      `chrome-extension://${extensionId}/preview-sandbox.html?release-preview=preview`,
      async (sandboxSession, contextId) => {
        try {
          await evaluate(chrome, sandboxSession, probeSource, contextId);
          await evaluate(chrome, session, 'window.mitterPreviewFixture.spoof()');
          await waitFor(
            chrome,
            sandboxSession,
            'window.mitterPreviewProbe.inspect().foreignMessages === 1',
            'actual foreign opaque WindowProxy message receipt',
            contextId,
          );
          let probe = await inspectProbe(chrome, sandboxSession, contextId);
          assert.equal(probe.foreignOrigin, 'null');
          assert.equal(probe.frames, 0, 'A valid payload from a foreign opaque sender must be rejected.');
          assert.equal(probe.installations, 0);
          assert.equal(probe.nativeAccess, false);

          await evaluate(chrome, session, 'window.mitterPreviewFixture.malformed()');
          const malformed = (await inspectFixture(chrome, session)).malformedSent;
          assert.ok(malformed > 0);
          await waitFor(
            chrome,
            sandboxSession,
            `window.mitterPreviewProbe.inspect().parentMessages === ${malformed}`,
            'all malformed parent payloads reaching the sandbox',
            contextId,
          );
          probe = await inspectProbe(chrome, sandboxSession, contextId);
          assert.equal(probe.frames, 0, 'Malformed messages must not install an inner frame.');
          assert.equal(probe.installations, 0);

          await evaluate(chrome, session, 'window.mitterPreviewFixture.send()');
          await waitFor(
            chrome,
            session,
            'window.mitterPreviewFixture.inspect().innerReady === 1',
            'exact marker render, inline script, parent DOM denial and no inner extension API',
          );
          assert.equal((await inspectFixture(chrome, session)).innerOrigin, 'null');
          probe = await inspectProbe(chrome, sandboxSession, contextId);
          const policy =
            "default-src 'none'; script-src 'unsafe-inline' data: blob:; " +
            "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; " +
            "connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
          const expected =
            '<!doctype html><meta http-equiv="Content-Security-Policy" content="' +
            policy +
            '">' +
            fixture.html;
          assert.equal(probe.html, expected, 'The literal HTML must follow the unchanged leading CSP.');
          assert.equal(probe.frames, 1);
          assert.equal(probe.installations, 1);
          assert.equal(probe.sandbox, 'allow-scripts');
          assert.equal(probe.referrerPolicy, 'no-referrer');
          assert.equal(probe.title, 'Isolated local file preview');
          assert.equal(probe.parentMessages, malformed + 1, 'Invalid messages must not consume the gate.');

          await evaluate(chrome, session, 'window.mitterPreviewFixture.replay()');
          await waitFor(
            chrome,
            sandboxSession,
            `window.mitterPreviewProbe.inspect().parentMessages === ${malformed + 2}`,
            'replayed valid parent payload receipt',
            contextId,
          );
          const replayed = await inspectProbe(chrome, sandboxSession, contextId);
          assert.equal(replayed.html, expected, 'The one-use gate must preserve the first exact document.');
          assert.equal(replayed.frames, 1);
          assert.equal(replayed.installations, 1, 'Replay must not replace even an identical iframe.');
          assert.equal((await inspectFixture(chrome, session)).innerReady, 1);
        } finally {
          await evaluate(chrome, sandboxSession, 'window.mitterPreviewProbe?.destroy()', contextId);
        }
      },
    );
  } finally {
    await evaluate(chrome, session, 'window.mitterPreviewFixture?.destroy()');
  }
}
