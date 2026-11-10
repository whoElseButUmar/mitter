import { onCleanup } from 'solid-js';

export function createTaskSound(): () => Promise<void> {
  const contexts = new Set<AudioContext>();

  let disposed = false;

  const close = async (audio: AudioContext) => {
    contexts.delete(audio);
    if (audio.state !== 'closed') {
      await audio.close();
    }
  };

  onCleanup(() => {
    disposed = true;
    for (const audio of contexts) {
      void close(audio).catch((error) => console.warn('Miter sound could not close.', error));
    }
  });

  return async () => {
    if (disposed) {
      return;
    }

    let audio: AudioContext | undefined;

    try {
      audio = new AudioContext();
      const activeAudio = audio;
      contexts.add(activeAudio);
      await activeAudio.resume();

      if (disposed) {
        return;
      }

      const gain = activeAudio.createGain();
      gain.connect(activeAudio.destination);
      gain.gain.setValueAtTime(0, activeAudio.currentTime);
      gain.gain.linearRampToValueAtTime(0.06, activeAudio.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, activeAudio.currentTime + 0.38);

      const oscillator = activeAudio.createOscillator();
      oscillator.frequency.value = 880;
      oscillator.connect(gain);
      oscillator.onended = () => {
        void close(activeAudio).catch((error) => console.warn('Miter sound could not close.', error));
      };
      oscillator.start();
      oscillator.stop(activeAudio.currentTime + 0.4);
    } catch (error) {
      if (audio) {
        await close(audio).catch((closeError) => console.warn('Miter sound could not close.', closeError));
      }

      console.warn('Miter sound could not play.', error);
    }
  };
}
