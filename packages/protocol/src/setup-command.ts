/** Shell spelling for display and copy only. The host executes the original argument array. */
export function formatSetupCommand(
  command: readonly string[],
  shell: 'posix' | 'powershell' = 'posix',
): string {
  if (shell === 'powershell') {
    return '& ' + command.map((argument) => "'" + argument.replaceAll("'", "''") + "'").join(' ');
  }
  return command
    .map((argument, index) => {
      const keyword =
        index === 0 &&
        /^(?:if|then|else|elif|fi|do|done|case|esac|for|in|while|until|function|time|select|coproc|repeat|end|foreach|nocorrect)$/.test(
          argument,
        );
      if (!keyword && /^[A-Za-z0-9_@%+,./:-]+$/.test(argument)) {
        return argument;
      }
      return "'" + argument.replaceAll("'", "'\\''") + "'";
    })
    .join(' ');
}
