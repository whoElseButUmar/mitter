import { taskChimeMessage } from '../task-chime.js';

const documentPath = 'notification-audio.html';

export function createNotificationAudio() {
  let opening: Promise<void> | undefined;

  function openDocument(): Promise<void> {
    opening ??= (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [chrome.runtime.getURL(documentPath)],
      });
      if (!contexts.length) {
        await chrome.offscreen.createDocument({
          url: documentPath,
          reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
          justification: 'Play the task notification sound when Miter’s panel is closed.',
        });
      }
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  return async (isCurrent: () => boolean): Promise<void> => {
    await openDocument();
    if (isCurrent() && (await chrome.runtime.sendMessage(taskChimeMessage)) !== true) {
      throw new Error('Chrome did not play the notification sound.');
    }
  };
}
