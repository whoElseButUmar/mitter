import { z } from 'zod';
import type { PageTransport } from '../../../../packages/bridge/src/page-transport';
import { DOM_READER_URL } from './dom-reader-contracts';

const samplePng =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGMQMj544dEqhk/qFhMmLwAAK84Gd2fVDssAAAAASUVORK5CYII=';
const sampleGif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function mountImageComposer() {
  const form = document.createElement('form');
  const composer = document.createElement('textarea');
  composer.id = 'prompt-textarea';
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.setAttribute('aria-label', 'Attach files');

  const send = document.createElement('button');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Send');
  send.textContent = 'Send';

  const pendingFiles = new Map<string, File>();
  input.onchange = () => {
    form.dataset.uploads = String(Number(form.dataset.uploads ?? '0') + 1);
    for (const file of Array.from(input.files ?? [])) {
      const slot = document.createElement('div');
      const spinner = document.createElement('span');
      spinner.setAttribute('role', 'progressbar');
      const preview = document.createElement('div');
      preview.setAttribute('role', 'button');
      const thumbnail = document.createElement('img');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + file.name);
      remove.textContent = 'Remove';
      remove.onclick = () => {
        pendingFiles.delete(file.name);
        slot.remove();
      };
      preview.append(thumbnail, spinner);
      slot.append(preview, remove);
      form.prepend(slot);
      pendingFiles.set(file.name, file);

      slot.addEventListener('mitter-fixture-finish-upload', () => {
        spinner.remove();
        preview.setAttribute('aria-label', file.name);
        thumbnail.alt = file.name;
      });
    }
  };

  form.onsubmit = (event) => {
    event.preventDefault();
    form.dataset.sends = String(Number(form.dataset.sends ?? '0') + 1);
    const outgoing = [...pendingFiles.values()];
    void Promise.all(
      outgoing.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { type: file.type, name: file.name, base64: btoa(String.fromCharCode(...bytes)) };
      }),
    ).then((images) => {
      form.dataset.result = JSON.stringify({ prompt: composer.value, images });
    });
  };

  form.append(composer, input, send);
  document.body.replaceChildren(form);
}

const evidenceSchema = z
  .strictObject({
    uploads: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of file change events received by the fixture composer.'),
    sends: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of form submissions received by the fixture composer.'),
    result: z
      .string()
      .describe('Exact transmitted synthetic prompt and attachment data, only for local comparison.'),
  })
  .describe('Synthetic provider-side composer observations.');

function outcomeIs(expected: string, observed: string | undefined): void {
  if (observed !== expected) {
    throw new Error('Expected the page transport outcome ' + expected + ', received ' + observed + '.');
  }
}

/** Exercises the production page adapter against the observed ChatGPT composer
 * markup in the already-owned, network-blocked Chrome fixture. */
export async function checkImageSend(tabId: number, transport: PageTransport) {
  const target = { tabId, frameIds: [0] };
  await chrome.scripting.executeScript({ target, world: 'ISOLATED', func: mountImageComposer });
  const imageAttachments = [
    {
      id: '7c5f9131-a077-4eb9-b049-a7cd09c00d4e',
      type: 'image/png',
      name: 'Screenshot.png',
      size: atob(samplePng).length,
    },
    {
      id: '2488c5ac-bd47-40c2-b5dc-2432bed665a1',
      type: 'image/gif',
      name: 'Reference.gif',
      size: atob(sampleGif).length,
    },
  ] as const;
  const [first, second] = imageAttachments;
  const request = {
    token: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    url: DOM_READER_URL,
    expiresAt: Date.now() + 60000,
    text: 'Apply the two synthetic image references to this screen.',
    imageAttachments: [...imageAttachments],
  };
  const prepared = await transport.request(tabId, { ...request, op: 'prepare' });
  outcomeIs('prepared', prepared.outcome);
  let composerSession = prepared.composerSession;
  if (!composerSession) {
    throw new Error('The page did not bind the prepared composer document.');
  }

  const beforeBytes = await transport.request(tabId, {
    ...request,
    composerSession,
    op: 'attach_image',
    image: { attachment: first },
  });
  outcomeIs('image_needed', beforeBytes.readiness);
  const staged = await transport.request(tabId, {
    ...request,
    composerSession,
    op: 'attach_image',
    image: { attachment: first, base64: samplePng },
  });
  outcomeIs('uploading_images', staged.readiness);

  const recovered = { ...request, token: crypto.randomUUID() };
  const recoveredDraft = await transport.request(tabId, { ...recovered, op: 'prepare' });
  outcomeIs('prepared', recoveredDraft.outcome);
  composerSession = recoveredDraft.composerSession;
  if (!composerSession) {
    throw new Error('The page did not bind the reconnected composer document.');
  }
  const bound = { ...recovered, composerSession };

  const refused = await transport
    .request(tabId, {
      ...bound,
      op: 'attach_image',
      composerSession: 'different-document',
      image: { attachment: second },
    })
    .catch((error: unknown) => error);
  if (!(refused instanceof Error) || !('code' in refused) || refused.code !== 'IMAGE_DOCUMENT_CHANGED') {
    throw new Error('A different document did not block an image operation.');
  }

  const retry = await transport.request(tabId, {
    ...bound,
    op: 'attach_image',
    image: { attachment: first, base64: samplePng },
  });
  outcomeIs('uploading_images', retry.readiness);
  const finishUploads = async () => {
    await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      func: () => {
        for (const spinner of document.querySelectorAll('form [role="progressbar"]')) {
          spinner
            .closest('div[role="button"]')
            ?.parentElement?.dispatchEvent(new Event('mitter-fixture-finish-upload'));
        }
      },
    });
  };
  await finishUploads();
  const firstUploaded = await transport.request(tabId, {
    ...bound,
    op: 'attach_image',
    image: { attachment: first },
  });
  outcomeIs('attached', firstUploaded.outcome);

  await transport.request(tabId, {
    ...bound,
    op: 'attach_image',
    image: { attachment: second, base64: sampleGif },
  });
  const early = await transport.request(tabId, { ...bound, op: 'commit' });
  outcomeIs('uploading_images', early.readiness);
  await finishUploads();
  const secondUploaded = await transport.request(tabId, {
    ...bound,
    op: 'attach_image',
    image: { attachment: second },
  });
  outcomeIs('attached', secondUploaded.outcome);

  const conflict = await transport
    .request(tabId, {
      ...bound,
      op: 'commit',
      imageAttachments: [first],
    })
    .catch((error: unknown) => error);
  if (!(conflict instanceof Error) || !('code' in conflict) || conflict.code !== 'NOT_PREPARED') {
    throw new Error('Changing the image set did not block the send request.');
  }

  const commit = { ...bound, op: 'commit' as const };
  outcomeIs('clicked', (await transport.request(tabId, commit)).outcome);
  outcomeIs('already_clicked', (await transport.request(tabId, commit)).outcome);

  const [evidenceResult] = await chrome.scripting.executeScript({
    target,
    world: 'ISOLATED',
    func: () => {
      const form = document.querySelector('form');
      return {
        uploads: Number(form?.dataset.uploads),
        sends: Number(form?.dataset.sends),
        result: form?.dataset.result ?? '',
      };
    },
  });
  const evidence = evidenceSchema.parse(evidenceResult?.result);
  const filename = (id: string, original: string) => 'miter-' + request.messageId + '-' + id + '-' + original;
  if (
    evidence.result !==
    JSON.stringify({
      prompt: request.text,
      images: [
        { type: first.type, name: filename(first.id, first.name), base64: samplePng },
        { type: second.type, name: filename(second.id, second.name), base64: sampleGif },
      ],
    })
  ) {
    throw new Error('The fixture did not receive the original prompt and both image files intact.');
  }
  return { uploads: evidence.uploads, sends: evidence.sends };
}
