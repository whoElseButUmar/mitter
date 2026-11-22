export const taskChimeMessage = 'miter:play-task-chime';

export function createChime() {
  let context: AudioContext | undefined;
  let disposed = false;

  const close = async (audio: AudioContext) => {
    if (context === audio) {
      context = undefined;
    }
    if (audio.state !== 'closed') {
      await audio.close();
    }
  };

  async function play(): Promise<void> {
    if (disposed || context) {
      return;
    }

    const audio = new AudioContext();
    context = audio;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        audio.resume(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Chrome did not start audio playback.')), 2000);
        }),
      ]);
      if (disposed) {
        return;
      }

      const now = audio.currentTime;
      const gain = audio.createGain();
      gain.connect(audio.destination);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);

      const tone = audio.createOscillator();
      tone.frequency.setValueAtTime(660, now);
      tone.frequency.setValueAtTime(880, now + 0.12);
      tone.connect(gain);
      tone.onended = () => void close(audio).catch(console.warn);
      tone.start();
      tone.stop(now + 0.38);
    } catch (error) {
      await close(audio);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function dispose(): void {
    disposed = true;
    if (context) {
      void close(context).catch(console.warn);
    }
  }

  return { play, dispose };
}
