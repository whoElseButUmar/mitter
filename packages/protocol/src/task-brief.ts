/** Local, deterministic task shaping. It does not call a model, change the
 * user's goal/checks, or grant a permission. The coder interprets the full goal. */
export interface TaskBrief {
  title: string;
  kind: 'tic-tac-toe' | 'color-memory' | 'general';
  approach: string[];
  quality: string[];
  defaults: string[];
}
const tidy = (text: string) => text.replace(/^(?:Worker name|The goal):\s*/i, '').trim();
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1);
  const space = clipped.lastIndexOf(' ');
  return (space > max / 2 ? clipped.slice(0, space) : clipped).trimEnd() + '…';
}
export function buildTaskBrief(request: string): TaskBrief {
  const goal = tidy(request);
  const game = /\bgame\b|tic[ -]?tac[ -]?toe|noughts\s+and\s+crosses/i.test(goal);
  const kind: TaskBrief['kind'] = /tic[ -]?tac[ -]?toe|noughts\s+and\s+crosses|\bxo\b/i.test(goal) && game
    ? 'tic-tac-toe'
    : /colou?r[ -]?(?:order[ -]?)?memory|memory[ -]?(?:sequence|game)/i.test(goal) && game
      ? 'color-memory' : 'general';
  const changeExisting = /^(?:please\s+)?(?:fix|repair|debug|change|update|refactor|remove|improve|add)\b/i.test(goal);
  const lead = goal.split(/[\r\n]/)[0]!.replace(/^(?:please\s+)?(?:can you\s+)?(?:make|build|create)(?:\s+me)?(?:\s+like)?\s+(?:(?:a|an|the)\s+)?/i, '').replace(/[.!?]+$/, '').trim();
  const name = !changeExisting && kind === 'tic-tac-toe' ? 'Tic-tac-toe'
    : !changeExisting && kind === 'color-memory' ? 'Color Memory'
    : lead ? lead[0]!.toUpperCase() + lead.slice(1) : 'New task';
  const approach = [
    'Inspect the project first. Preserve existing work and follow its stack and conventions.',
    'Turn the request into a small, concrete implementation plan. Keep the requested style and features; do not add unrelated scope.',
    'Implement, inspect the saved result, run available approved checks, and repair failures before requesting completion.',
  ];
  const quality = [
    'Every visible control has a purpose and works; show loading, empty, error and finished states where relevant.',
    'Use familiar navigation and labels, readable contrast, keyboard focus and responsive layouts. Keep advanced controls out of the main path.',
    'Report what was actually verified and what was not. A source read-back is not a browser interaction test.',
  ];
  const defaults = [
    'The original request overrides these defaults. Choose reversible details without asking; ask only for a consequential unresolved decision.',
    'Do not add accounts, analytics, backend services, package installs or network access unless the task genuinely requires them and permissions allow it.',
  ];
  if (game && !changeExisting) defaults.push('For a new, empty browser-game project with no requested framework, prefer index.html, styles.css and script.js, opening directly in the browser. Keep an existing or explicitly requested stack instead.');
  if (kind === 'tic-tac-toe') {
    approach.push(changeExisting ? 'For the requested change, preserve the existing game rules and verify the affected turn, win/draw and restart behavior. Do not rebuild unrelated features.' : 'Cover a 3×3 board, X/O turns, occupied-cell protection, every winning line, a draw, and restart. Prevent further moves after a finished game.');
    if (!changeExisting) defaults.push('Unless the request says otherwise, use two local players. Do not invent online play or an AI opponent.');
    quality.push('Check win, draw and restart logic. Include pointer/touch input and keyboard-accessible cells with an unambiguous turn/result indicator.');
  } else if (kind === 'color-memory') {
    approach.push('Cover sequence playback, input locked during playback, correct-order input, sequence growth, score, mistake/game-over and restart.');
    quality.push('Check that restart cancels old timers and that input cannot leak between playback and the player’s turn.');
  }
  if (/skeuomorph|skumorph|skewmorph|skeumorph|skewmr/i.test(goal)) {
    quality.push('Use restrained skeuomorphism: tactile bevels, inset surfaces, subtle highlights and real pressed states. Materials support readability; do not bury the game in ornamental panels.');
  }
  return {title: clipWords(name, 50), kind, approach, quality, defaults};
}
export function suggestedTaskName(request: string): string { return buildTaskBrief(request).title; }
/** Repair display-only legacy auto-titles; never rename an explicit user title. */
export function displayTaskName(task: {name: string; goal: string}): string {
  const cleaned = tidy(task.name);
  const goal = tidy(task.goal), first = goal.split('\n')[0]!;
  if (cleaned === first.slice(0, 55) || cleaned === first.slice(0, 60)) return suggestedTaskName(goal);
  return cleaned || suggestedTaskName(goal);
}
export function taskBriefText(goal: string): string {
  const brief = buildTaskBrief(goal);
  return [
    'MITTER BUILD BRIEF (local template; subordinate to the original request)',
    'APPROACH', ...brief.approach.map(s => '- ' + s),
    'QUALITY BAR', ...brief.quality.map(s => '- ' + s),
    'DEFAULTS, NOT ADDITIONAL REQUIREMENTS', ...brief.defaults.map(s => '- ' + s),
    'PROGRESS AND STOPPING',
    '- Use the batch summary to say what this step does and what remains. Continue concrete work rather than repeatedly expanding the plan.',
    '- Fix reported failures, then request finish once the requested behavior is implemented. Do not keep polishing forever or invent features to fill turns.',
    '- The checklist above is guidance, not executable verification. Configured checks still gate completion. Finished without configured checks does not mean independently verified; no separate acceptance click is required.',
    '- Never claim browser, audio, build or test success without the corresponding execution evidence. No browser-testing tool is implied by this brief.',
  ].join('\n');
}
