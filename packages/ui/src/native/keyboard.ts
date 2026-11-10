/** Index navigation shared by menus, tabs and enabled select options. */
export function navigationIndex(key: string, current: number, length: number): number | undefined {
  if (!length || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
    return undefined;
  }

  if (key === 'Home') {
    return 0;
  }

  if (key === 'End') {
    return length - 1;
  }

  let delta = 1;

  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    delta = -1;
  }

  return (current + delta + length) % length;
}

/** Each widget owns its buffer; opening/closing rules remain with the widget. */
export function createTypeahead() {
  let buffer = '';
  let typedAt = 0;

  return {
    active(): boolean {
      return buffer !== '' && Date.now() - typedAt < 700;
    },
    reset(): void {
      buffer = '';
      typedAt = 0;
    },
    append(character: string): string {
      const now = Date.now();

      if (now - typedAt < 700) {
        buffer += character;
      } else {
        buffer = character;
      }

      typedAt = now;
      const query = buffer.toLocaleLowerCase();
      const first = query[0];

      if (first !== undefined && [...query].every((letter) => letter === first)) {
        return first;
      }

      return query;
    },
  };
}
