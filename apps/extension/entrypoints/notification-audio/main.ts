import { createChime, taskChimeMessage } from '../../src/task-chime';

const chime = createChime();
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (
    message !== taskChimeMessage ||
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL('background.js') ||
    sender.tab
  ) {
    return;
  }

  void chime.play().then(
    () => respond(true),
    () => respond(false),
  );
  return true;
});
