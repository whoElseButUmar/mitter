import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test, type TestContext } from 'node:test';
import type { ChatDomSession, ComposerState } from './session-state.ts';
import type { ChatView, DomRequest } from './types.ts';

// Production uses emitted .js paths; these tests run the same modules directly
// with Node's native TypeScript support, without a build or test dependency.
const sourceImports = registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !specifier.endsWith('.js')
      ) {
        throw error;
      }
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
  },
});
const adapter = await import('../chat-dom.ts');
const { readAssistantMessage } = await import('./assistant-reader.ts');
const { sendComposerMessage } = await import('./composer-operations.ts');
const { setReceiptRole } = await import('./transcript-discovery.ts');
const { createVisibilityReader } = await import('./page-elements.ts');
sourceImports.deregister();

function installGlobals(context: TestContext, values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    context.after(() => {
      if (previous) {
        Object.defineProperty(globalThis, name, previous);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    });
  }
}

const request: DomRequest = {
  op: 'control',
  token: 'task-token',
  url: 'https://chatgpt.com/c/conversation',
  expiresAt: Number.MAX_SAFE_INTEGER,
};

function sessionFixture(stopped = false): ChatDomSession {
  return {
    token: request.token,
    composerSession: 'document-session',
    stopped,
    prepared: {
      id: 'message',
      text: 'outgoing text',
      userCount: 0,
      lastUserText: '',
    },
    committed: new Map([['message', { text: 'outgoing text', time: 123 }]]),
    reveals: new Map(),
  };
}

function viewFixture(): ChatView {
  return {
    url: request.url,
    count: 0,
    userCount: 0,
    lastRole: '',
    assistantId: '',
    assistantText: 'unchanged',
    lastUserText: '',
    busy: false,
    complete: false,
    draft: false,
    draftText: '',
    stopped: false,
  };
}

test('chat-dom retains its original runtime exports and reader version', () => {
  const originalExports = [
    'ASSISTANT_READER_VERSION',
    'chatDom',
    'clearChatDomState',
    'discoverMessages',
    'discoverReceiptMessages',
    'editableText',
    'logicalMessages',
    'messageDisclosure',
    'messageIdentity',
    'messageRole',
    'readAssistantMessage',
    'readCodeReply',
    'readUserMessage',
    'readUserMessageVariants',
  ];
  for (const name of originalExports) {
    assert.ok(Object.hasOwn(adapter, name), `Missing compatibility export: ${name}`);
  }
  assert.equal(adapter.readAssistantMessage, readAssistantMessage);
  assert.equal(
    adapter.ASSISTANT_READER_VERSION,
    'logical-pre/5-user-turn/8-discovery/8-code-reply/6-send/4-control/2',
  );
});

test('schemas preserve genuine observation absences without adding defaults', () => {
  const view = viewFixture();
  assert.deepEqual(adapter.chatViewSchema.parse(view), view);
  const parsedRequest = adapter.domRequestSchema.parse(request);
  assert.deepEqual(parsedRequest, request);
  assert.equal(Object.hasOwn(parsedRequest, 'receipt'), false);
  assert.equal(Object.hasOwn(parsedRequest, 'composerSession'), false);
  assert.equal(Object.hasOwn(adapter.chatViewSchema.parse(view), 'disclosure'), false);
  assert.ok(adapter.chatViewSchema.description);
  assert.ok(adapter.domRequestSchema.shape.op.description);
  assert.equal(adapter.chatViewSchema.safeParse({ ...view, count: -1 }).success, false);
  assert.equal(
    adapter.domRequestSchema.safeParse({
      ...request,
      workerId: 'not a valid ID',
    }).success,
    false,
  );
});

test('legacy code observations do not require optional format or correlation fields', () => {
  const reply = {
    id: 'reply',
    workerId: 'worker',
    projectId: 'project',
    text: '{}',
    hasCopyControl: false,
  };
  assert.deepEqual(adapter.codeReplySchema.parse(reply), reply);
  assert.deepEqual(adapter.codeReplyScanSchema.parse({ count: 0, issue: 'TASK_REQUIRED' }), {
    count: 0,
    issue: 'TASK_REQUIRED',
  });
});

test('fenced assistant payloads use textContent, never layout text', (context) => {
  class ElementFixture {}
  const payload = '{"source":"  keep  spaces\\n`backticks`\\t\\\\"}\n';
  const code = {
    textContent: payload,
    innerText: 'corrupted layout text',
    parentElement: null,
  };
  const pre = {
    tagName: 'PRE',
    querySelectorAll: () => [code],
    parentElement: null,
  };
  const body = {
    tagName: 'DIV',
    innerText: 'corrupted layout text',
    textContent: payload,
    querySelectorAll(selector: string) {
      if (selector === 'pre') {
        return [pre];
      }
      return [];
    },
  };
  for (const element of [code, pre, body]) {
    Object.setPrototypeOf(element, ElementFixture.prototype);
  }
  installGlobals(context, {
    HTMLElement: ElementFixture,
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      contentVisibility: 'visible',
    }),
    NodeFilter: { SHOW_TEXT: 4 },
    document: { createTreeWalker: () => ({ nextNode: () => false }) },
  });
  const message: unknown = body;
  assert.ok(message instanceof HTMLElement);
  const result = adapter.readAssistantMessage(message);
  assert.equal(result.text, payload);
  assert.equal(result.format, 'code');
  assert.equal(result.source, code);
  assert.equal(result.stats?.logicalBlocks, 1);
});

test('logical editor lines preserve inline adjacency and empty blocks', (context) => {
  class ElementFixture {
    nodeType = 1;
    tagName: string;
    childNodes: Array<ElementFixture | { nodeType: number; nodeValue: string }>;
    classList: { contains: (name: string) => boolean };
    constructor(tagName: string, children: ElementFixture['childNodes'] = [], trailingBreak = false) {
      this.tagName = tagName;
      this.childNodes = children;
      this.classList = {
        contains: (name) => trailingBreak && name === 'ProseMirror-trailingBreak',
      };
    }
  }
  const text = (value: string) => ({ nodeType: 3, nodeValue: value });
  const root: unknown = new ElementFixture('DIV', [
    new ElementFixture('P', [new ElementFixture('SPAN', [text('worker-')]), text('id  ')]),
    new ElementFixture('DIV', [new ElementFixture('BR')]),
    new ElementFixture('P', [text('next line'), new ElementFixture('BR', [], true)]),
  ]);
  installGlobals(context, {
    HTMLElement: ElementFixture,
    Node: { TEXT_NODE: 3 },
  });
  assert.ok(root instanceof HTMLElement);
  assert.equal(adapter.editableText(root), 'worker-id  \n\nnext line');
});

test('control observes only its token and never replaces the global session', async (context) => {
  const session = sessionFixture(true);
  installGlobals(context, {
    location: new URL(request.url),
    __mitterSessionV4: session,
  });
  const owned = await adapter.chatDom(request);
  assert.equal(owned.stopped, true);
  assert.equal(owned.ready, true);
  const stale = await adapter.chatDom({ ...request, token: 'stale-token' });
  assert.equal(stale.stopped, false);
  assert.equal(stale.ready, false);
  assert.equal(adapter.getChatDomSession(), session);
});

test('stop cannot retire a different token or remove its control', async (context) => {
  const session = sessionFixture();
  let removals = 0;
  installGlobals(context, {
    location: new URL(request.url),
    __mitterSessionV4: session,
    document: {
      getElementById: () => ({
        remove: () => {
          removals++;
        },
      }),
    },
  });
  await adapter.chatDom({ ...request, op: 'stop', token: 'stale-token' });
  assert.equal(session.stopped, false);
  assert.equal(removals, 0);
  await adapter.chatDom({ ...request, op: 'stop' });
  assert.equal(session.stopped, true);
  assert.equal(removals, 1);
});

test('an expired request cannot adopt or mutate the session', async (context) => {
  const session = sessionFixture();
  installGlobals(context, {
    location: new URL(request.url),
    __mitterSessionV4: session,
  });
  await assert.rejects(adapter.chatDom({ ...request, expiresAt: 0 }), {
    code: 'SESSION_EXPIRED',
  });
  assert.equal(adapter.getChatDomSession(), session);
  assert.equal(session.stopped, false);
});

test('a commit bound to another document cannot replace the session or click Send', async (context) => {
  const session = sessionFixture();
  installGlobals(context, {
    location: new URL(request.url),
    __mitterSessionV4: session,
  });
  await assert.rejects(
    adapter.chatDom({
      ...request,
      op: 'commit',
      composerSession: 'another-document',
    }),
    { code: 'COMMIT_DOCUMENT_CHANGED' },
  );
  assert.equal(adapter.getChatDomSession(), session);
  assert.equal(session.committed.size, 1);
});

test('probe does not adopt a stopped session or touch disclosure controls', async (context) => {
  const session = sessionFixture(true);
  installGlobals(context, {
    location: new URL(request.url),
    __mitterSessionV4: session,
    HTMLElement: class {},
    HTMLTextAreaElement: class {},
    document: {
      readyState: 'loading',
      visibilityState: 'visible',
      getElementById: () => {
        throw new Error('Probe must not change the automation control.');
      },
    },
  });
  const view = await adapter.chatDom({ ...request, op: 'probe' });
  assert.equal(view.stopped, false);
  assert.equal(view.composerSession, undefined);
  assert.equal(view.readiness, 'loading');
  assert.equal(adapter.getChatDomSession(), session);
  assert.equal(session.stopped, true);
});

for (const stopped of [false, true]) {
  test(`reinjection preserves ledgers and the existing stopped=${stopped} state`, (context) => {
    const previous = sessionFixture(stopped);
    installGlobals(context, { __mitterSessionV4: previous });
    adapter.retireChatDomSession();
    const replacement = adapter.getChatDomSession();
    assert.ok(replacement);
    assert.notEqual(replacement, previous);
    assert.equal(previous.stopped, true);
    assert.equal(replacement.stopped, stopped);
    assert.equal(replacement.token, previous.token);
    assert.equal(replacement.composerSession, previous.composerSession);
    assert.equal(replacement.prepared, previous.prepared);
    assert.equal(replacement.committed, previous.committed);
    assert.equal(replacement.reveals, previous.reveals);
  });
}

test('a retried committed send reconciles without touching the composer', async () => {
  const session: ComposerState = {
    prepared: null,
    committed: new Map([['message', { text: 'outgoing text', time: 123 }]]),
  };
  const view = viewFixture();
  const unexpectedMutation = (): never => {
    throw new Error('A committed retry must not reach composer checks.');
  };
  const result = await sendComposerMessage(
    { ...request, op: 'commit', text: 'outgoing text', messageId: 'message' },
    session,
    async () => view,
    unexpectedMutation,
    unexpectedMutation,
  );
  assert.deepEqual(result, { ...view, outcome: 'already_clicked' });
  await assert.rejects(
    sendComposerMessage(
      { ...request, op: 'commit', text: 'changed text', messageId: 'message' },
      session,
      async () => view,
      unexpectedMutation,
      unexpectedMutation,
    ),
    { code: 'MESSAGE_CONFLICT' },
  );
});

test('reset retires both session versions and clears shared discovery hints', (context) => {
  class ElementFixture {}
  const previous = sessionFixture();
  const current = sessionFixture();
  const fixture = {
    id: '',
    parentElement: null,
    getAttribute: () => null,
    getRootNode: () => null,
    matches: () => false,
  };
  Object.setPrototypeOf(fixture, ElementFixture.prototype);
  let removedControl = '';
  installGlobals(context, {
    __mitterSessionV3: previous,
    __mitterSessionV4: current,
    HTMLElement: ElementFixture,
    ShadowRoot: class {},
    document: {
      getElementById: (id: string) => ({
        remove: () => {
          removedControl = id;
        },
      }),
    },
  });
  const message: unknown = fixture;
  assert.ok(message instanceof HTMLElement);
  setReceiptRole(message, 'user', 'receipt-identity');
  assert.equal(adapter.messageRole(message), 'user');
  assert.equal(adapter.messageIdentity(message), 'receipt-identity');
  adapter.clearChatDomState();
  for (const session of [previous, current]) {
    assert.equal(session.stopped, true);
    assert.equal(session.prepared, null);
    assert.equal(session.committed.size, 0);
    assert.equal(session.reveals?.size, 0);
  }
  assert.equal(globalThis.__mitterSessionV3, undefined);
  assert.equal(globalThis.__mitterSessionV4, undefined);
  assert.equal(Object.hasOwn(globalThis, '__mitterSessionV3'), false);
  assert.equal(Object.hasOwn(globalThis, '__mitterSessionV4'), false);
  assert.equal(adapter.messageRole(message), '');
  assert.equal(adapter.messageIdentity(message), '');
  assert.equal(removedControl, 'mitter-automation-control');
});

for (const op of ['prepare', 'commit'] as const) {
  test(`${op}: an adopted bootstrap cannot refill a cleared composer or send into a changed chat`, async () => {
    for (const changed of [
      { draft: false, draftText: '' },
      { count: 1, userCount: 1 },
    ]) {
      const session = sessionFixture();
      const prepared = session.prepared;
      assert.ok(prepared);
      session.committed.clear();
      const view = { ...viewFixture(), assistantText: '', draft: true, draftText: prepared.text, ...changed };
      await assert.rejects(
        sendComposerMessage(
          { ...request, op, text: prepared.text, messageId: prepared.id, adoptBootstrapDraft: true },
          session,
          async () => view,
          () => {},
          () => true,
        ),
        { code: 'DRAFT_CHANGED' },
      );
      assert.equal(session.committed.size, 0);
    }
  });

  test(`${op}: manual Send evidence remains identical before either page mutation`, async (context) => {
    for (const evidence of ['text', 'rendered text', 'changed identity']) {
      await context.test(evidence, async () => {
        const session = sessionFixture();
        session.committed.clear();
        const prepared = session.prepared;
        assert.ok(prepared);
        const view = { ...viewFixture(), userCount: 1, lastUserText: prepared.text };
        if (evidence === 'rendered text') {
          prepared.renderedText = 'rendered outgoing text';
          view.lastUserText = prepared.renderedText;
        }
        if (evidence === 'changed identity') {
          prepared.lastUserText = prepared.text;
          prepared.lastUserId = 'optimistic-user';
          view.userCount = prepared.userCount;
          view.lastUserId = 'persisted-user';
        }
        const result = await sendComposerMessage(
          { ...request, op, text: prepared.text, messageId: prepared.id },
          session,
          async () => view,
          () => {},
          () => true,
        );
        assert.deepEqual(result, { ...view, outcome: 'already_sent' });
        // Prepare reconciliation records a manual Send; commit only observes it.
        assert.equal(session.committed.has(prepared.id), op === 'prepare');
      });
    }
  });

  test(`${op}: an unchanged identical prior turn is not evidence of a new Send`, async () => {
    const session = sessionFixture();
    session.committed.clear();
    const prepared = session.prepared;
    assert.ok(prepared);
    prepared.lastUserText = prepared.text;
    prepared.lastUserId = 'same-user';
    const view = {
      ...viewFixture(),
      busy: true,
      userCount: prepared.userCount,
      lastUserText: prepared.text,
      lastUserId: prepared.lastUserId,
    };
    const result = await sendComposerMessage(
      { ...request, op, text: prepared.text, messageId: prepared.id },
      session,
      async () => view,
      () => {},
      () => true,
    );
    assert.deepEqual(result, { ...view, outcome: 'pending', readiness: 'generating' });
    assert.equal(session.committed.size, 0);
  });

  test(`${op}: conflicting user bodies and identities retain the draft barrier`, async (context) => {
    for (const conflict of ['body', 'identity', 'uncleared draft']) {
      await context.test(conflict, async () => {
        const session = sessionFixture();
        session.committed.clear();
        const prepared = session.prepared;
        assert.ok(prepared);
        const view = { ...viewFixture(), lastUserText: 'A different human message' };
        if (conflict === 'identity') {
          prepared.lastUserText = 'A different human message';
          prepared.lastUserId = 'original-user';
          view.lastUserId = 'another-user';
        }
        if (conflict === 'uncleared draft') {
          view.lastUserText = prepared.text;
          view.userCount = 1;
          view.draft = true;
        }
        await assert.rejects(
          sendComposerMessage(
            { ...request, op, text: prepared.text, messageId: prepared.id },
            session,
            async () => view,
            () => {},
            () => true,
          ),
          { code: 'USER_TURN_CHANGED' },
        );
        assert.equal(session.committed.size, 0);
        assert.equal(session.prepared, prepared);
      });
    }
  });
}

test('visibility snapshots preserve descendant overrides and expire between serializations', (context) => {
  class ElementFixture {
    constructor(readonly parentElement: Element | null = null) {}
    hasAttribute(): boolean {
      return false;
    }
    getRootNode(): object {
      return {};
    }
  }
  installGlobals(context, { HTMLElement: ElementFixture, ShadowRoot: class {} });
  const parent: unknown = new ElementFixture();
  assert.ok(parent instanceof HTMLElement);
  const child: unknown = new ElementFixture(parent);
  assert.ok(child instanceof HTMLElement);
  let hiddenLayout = false;
  let reads = 0;
  installGlobals(context, {
    getComputedStyle: (element: Element) => {
      reads++;
      let visibility = 'visible';
      let display = 'block';
      if (element === parent) {
        visibility = 'hidden';
        if (hiddenLayout) {
          display = 'none';
        }
      }
      return { visibility, display, contentVisibility: 'visible' };
    },
  });
  const first = createVisibilityReader();
  assert.equal(first(child), false, 'A descendant may override inherited visibility.');
  assert.equal(first(parent), true);
  assert.equal(reads, 2, 'One CSS read per unique element in a synchronous snapshot.');
  hiddenLayout = true;
  const fresh = createVisibilityReader();
  assert.equal(fresh(child), true, 'A fresh serialization must observe changed ancestor display.');
  assert.equal(reads, 4);
});

test('reattaching to a waiting reply respects a pause already made in the chat', async (context) => {
  const session = sessionFixture(true);
  installGlobals(context, { location: new URL(request.url), __mitterSessionV4: session });
  await assert.rejects(
    adapter.chatDom({ ...request, op: 'inspect', token: 'replacement', preservePause: true }),
    {
      code: 'STOPPED',
    },
  );
  assert.equal(adapter.getChatDomSession(), session);
  assert.equal(session.stopped, true);
});
