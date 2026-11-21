import {
  readReplyJSON,
  isReadOnlyReply,
  isIncompleteReplyJSON,
  exceedsHandoffBytes,
  hasCompleteReplyFence,
} from '../../../protocol/src/reply-json.js';
import { identifierSchema } from '../schemas/primitives.js';
import { readAssistantMessage } from './assistant-reader.js';
import { contentHidden, htmlElements, pageElements, parentAcrossShadow } from './page-elements.js';
import { isAnalysisCode } from './provider-activity.js';
import { explicitRole } from './transcript-discovery.js';
import {
  taskReplyObservationSchema,
  type CodeReply,
  type CodeReplyScan,
  type CodeReadObservation,
  type TaskReplyObservation,
} from './types.js';

export function readCodeReply(
  workerId: string,
  projectId: string,
  replyId?: string,
  replyTo?: string,
  anchoredAssistant?: HTMLElement,
): CodeReplyScan {
  if (!identifierSchema.safeParse(workerId).success || !identifierSchema.safeParse(projectId).success) {
    return { count: 0, issue: 'TASK_REQUIRED' };
  }
  const pageScan = pageElements();
  if (pageScan.limited) {
    return { count: 0, issue: 'SCAN_LIMIT' };
  }
  const candidates: Array<{
    reply: CodeReply;
    node: HTMLElement;
    order: number;
  }> = [];
  const observations: Array<{
    node: HTMLElement;
    order: number;
    read: CodeReadObservation;
  }> = [];
  const codeSelector = 'pre,code,[data-testid="code-block"],.code-block';
  const isOuterAssistant = (element: HTMLElement) => {
    if (explicitRole(element) !== 'assistant') {
      return false;
    }
    for (
      let ancestor = parentAcrossShadow(element);
      ancestor && !ancestor.matches('body,html,main');
      ancestor = parentAcrossShadow(ancestor)
    ) {
      if (ancestor instanceof HTMLElement && explicitRole(ancestor) === 'assistant') {
        return false;
      }
    }
    return true;
  };
  const candidateRoots = pageScan.elements.filter(
    (element) =>
      (element === anchoredAssistant ||
        element.matches(codeSelector) ||
        (isOuterAssistant(element) && !element.querySelector(codeSelector))) &&
      !contentHidden(element) &&
      !isAnalysisCode(element) &&
      !element.closest(
        'form,textarea,[contenteditable="true"],nav,aside,blockquote,[data-mitter-ui],#mitter-automation-control',
      ) &&
      !element.querySelector('form,textarea,[contenteditable="true"]'),
  );
  for (const [order, root] of candidateRoots.entries()) {
    let insideUserMessage = false;
    for (
      let ancestor: Element | null = root;
      ancestor && !ancestor.matches('body,html,main');
      ancestor = parentAcrossShadow(ancestor)
    ) {
      if (ancestor instanceof HTMLElement && explicitRole(ancestor) === 'user') {
        insideUserMessage = true;
      }
    }
    if (insideUserMessage) {
      continue;
    }
    const isPlainRoot = !root.matches(codeSelector);
    let messageRoot = root;
    if (!isPlainRoot && root.tagName === 'CODE') {
      messageRoot = root.parentElement || root;
    }
    const assistantRead = readAssistantMessage(messageRoot);
    const payloadText = assistantRead.text;
    const payloadElement = assistantRead.source || root;
    // Nested highlighter/PRE wrappers are one observation. A partial second
    // reply is still an observation, even before it contains task IDs.
    if (
      observations.some(
        (observation) =>
          observation.node === payloadElement ||
          observation.node.contains(payloadElement) ||
          payloadElement.contains(observation.node),
      )
    ) {
      continue;
    }
    let envelope: unknown;
    try {
      if (payloadText.trim() && !exceedsHandoffBytes(payloadText)) {
        envelope = readReplyJSON(payloadText);
      }
    } catch {}
    const incomplete = !envelope && (!payloadText.trim() || isIncompleteReplyJSON(payloadText));
    const looksLikeJSON =
      /^\s*\{/.test(payloadText) ||
      hasCompleteReplyFence(payloadText) ||
      (incomplete && !!payloadText.trim()) ||
      (!payloadText.trim() && !isPlainRoot);
    if (!looksLikeJSON) {
      continue;
    }
    let fingerprintHash = 2166136261;
    for (let index = 0; index < Math.min(payloadText.length, 400001); index++) {
      fingerprintHash = Math.imul(fingerprintHash ^ payloadText.charCodeAt(index), 16777619);
    }
    let issue = 'INVALID_JSON';
    if (envelope) {
      issue = 'candidate';
    }
    const read: CodeReadObservation = {
      characters: Math.min(payloadText.length, 400001),
      fingerprint: (fingerprintHash >>> 0).toString(16),
      issue: assistantRead.issue || issue,
      incomplete,
    };
    const taskReplyResult = taskReplyObservationSchema.safeParse(envelope);
    let taskReply: TaskReplyObservation | undefined;
    if (
      taskReplyResult.success &&
      taskReplyResult.data.workerId === workerId &&
      taskReplyResult.data.projectId === projectId
    ) {
      taskReply = taskReplyResult.data;
    }
    if (taskReply && typeof taskReply.id === 'string' && identifierSchema.safeParse(taskReply.id).success) {
      read.replyId = taskReply.id;
    }
    if (
      taskReply &&
      typeof taskReply.replyTo === 'string' &&
      identifierSchema.safeParse(taskReply.replyTo).success
    ) {
      read.replyTo = taskReply.replyTo;
    }
    observations.push({ node: payloadElement, order, read });
    if (assistantRead.issue || !payloadText.trim() || exceedsHandoffBytes(payloadText)) {
      continue;
    }
    // Discovery needs an action list, not validated actions. Keep the original
    // envelope for read-only classification and the exact text for host admission.
    if (
      !taskReply ||
      taskReply.id === undefined ||
      !envelope ||
      typeof envelope !== 'object' ||
      !('actions' in envelope) ||
      !Array.isArray(envelope.actions)
    ) {
      continue;
    }
    if (assistantRead.format === 'rendered') {
      continue;
    }
    if (assistantRead.format !== 'code' && !isReadOnlyReply(envelope)) {
      read.issue = 'PLAIN_REPLY_REQUIRES_FENCE';
      continue;
    }
    let hasCopyControl = false;
    for (
      let ancestor: HTMLElement | null = payloadElement, depth = 0;
      ancestor && depth < 5 && !ancestor.matches('body,html,main');
      ancestor = ancestor.parentElement, depth++
    ) {
      const preCount = ancestor.querySelectorAll('pre').length;
      if (preCount > 2) {
        break;
      }
      if (
        htmlElements(ancestor, 'button,[role="button"]').some(
          (button) =>
            !contentHidden(button) &&
            /^(?:copy(?: code| code block)?|copied!?|copier le code)$/i.test(
              (
                button.getAttribute('aria-label') ||
                button.getAttribute('title') ||
                button.textContent ||
                ''
              ).trim(),
            ),
        )
      ) {
        hasCopyControl = true;
        break;
      }
    }
    let correlation: { replyTo?: string } = {};
    if (typeof taskReply.replyTo === 'string') {
      correlation = { replyTo: taskReply.replyTo };
    }
    candidates.push({
      node: payloadElement,
      order,
      reply: {
        id: taskReply.id,
        workerId,
        projectId,
        ...correlation,
        text: payloadText,
        hasCopyControl,
        format: assistantRead.format,
      },
    });
    if (candidates.length > 64) {
      return { count: candidates.length, issue: 'TOO_MANY_REPLIES' };
    }
  }
  const newestObservation = observations.at(-1);
  const replyIds = candidates.map((candidate) => candidate.reply.id);
  const total = candidates.length;
  const scanObservation = {
    ids: replyIds,
    total,
    read: newestObservation?.read,
  };
  const hasLaterUserMessage = (selectedCandidate: (typeof candidates)[number]) => {
    const selectedIndex = pageScan.elements.findIndex(
      (element) =>
        element === selectedCandidate.node ||
        (element.matches(codeSelector) && element.contains(selectedCandidate.node)),
    );
    return pageScan.elements.some(
      (element, index) =>
        index > selectedIndex &&
        !contentHidden(element) &&
        explicitRole(element) === 'user' &&
        !element.contains(selectedCandidate.node) &&
        !selectedCandidate.node.contains(element),
    );
  };
  const matchingCandidates = candidates.filter(
    (candidate) =>
      (!replyId || candidate.reply.id === replyId) && (!replyTo || candidate.reply.replyTo === replyTo),
  );
  if (matchingCandidates.length > 1) {
    return {
      ...scanObservation,
      count: matchingCandidates.length,
      issue: 'AMBIGUOUS_REPLIES',
    };
  }
  const latestCandidate = candidates.at(-1);
  const selectedCandidate = matchingCandidates[0];
  // Never cherry-pick the last *parseable* block while a later response is
  // incomplete or malformed. It is a wait barrier, not a repaired JSON reply.
  const priorCandidate = selectedCandidate || latestCandidate;
  if (
    replyTo &&
    newestObservation &&
    (!priorCandidate || newestObservation.order > priorCandidate.order) &&
    !candidates.some((candidate) => candidate.node === newestObservation.node)
  ) {
    if (priorCandidate && hasLaterUserMessage(priorCandidate)) {
      // Preserve the human-turn barrier; the coordinator separately recognizes
      // its own exact report. Fragment metadata remains available for waiting.
      return { ...scanObservation, count: 0, issue: 'NEWER_USER_MESSAGE' };
    }
    let issue = 'NEWER_REPLY_UNREADABLE';
    if (newestObservation.read.incomplete) {
      issue = 'REPLY_IN_PROGRESS';
    }
    return { ...scanObservation, count: 0, issue };
  }
  if (!selectedCandidate) {
    if (replyTo && !replyId && latestCandidate) {
      if (replyIds.filter((id) => id === latestCandidate.reply.id).length !== 1) {
        return { ...scanObservation, count: 0, issue: 'AMBIGUOUS_REPLIES' };
      }
      if (hasLaterUserMessage(latestCandidate)) {
        return { ...scanObservation, count: 0, issue: 'NEWER_USER_MESSAGE' };
      }
      let issue = 'MISSING_REPLY_TO';
      if (latestCandidate.reply.replyTo) {
        issue = 'STALE_REPLY_TO';
      }
      return {
        ...scanObservation,
        count: 0,
        issue,
        unlinked: latestCandidate.reply,
      };
    }
    let issue = 'NO_CODE_REPLY';
    if (replyTo) {
      issue = 'WAITING_CORRELATED_REPLY';
    }
    return { ...scanObservation, count: 0, issue };
  }
  if (
    replyTo &&
    candidates.some(
      (candidate) => candidate !== selectedCandidate && candidate.order > selectedCandidate.order,
    )
  ) {
    return { ...scanObservation, count: 1, issue: 'NEWER_TASK_REPLY' };
  }
  if (hasLaterUserMessage(selectedCandidate)) {
    return { ...scanObservation, count: 1, issue: 'NEWER_USER_MESSAGE' };
  }
  return { ...scanObservation, reply: selectedCandidate.reply, count: 1 };
}
