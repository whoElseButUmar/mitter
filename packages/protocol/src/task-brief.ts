/** Local deterministic shaping; it never changes the user's goal or permissions. */
import type { TaskBrief } from './schemas/task-brief.js';
export { taskBriefSchema, type TaskBrief } from './schemas/task-brief.js';

function tidy(text: string): string {
  return text.replace(/^(?:Worker name|The goal):\s*/i, '').trim();
}

function clipWords(text: string, maximum: number): string {
  if (text.length <= maximum) {
    return text;
  }

  let clipped = text.slice(0, maximum - 1);
  const space = clipped.lastIndexOf(' ');

  if (space > maximum / 2) {
    clipped = clipped.slice(0, space);
  }

  return clipped.trimEnd() + '…';
}

/** A launch-only request can be fulfilled locally. Any additional work goes to the normal coding task. */
export function isProjectLaunchRequest(input: string): boolean {
  if (!/\b(?:pnpm|vite|next(?:\.js)?|dev(?:elopment)? server)\b/i.test(input)) {
    return false;
  }
  const clauses = input
    .trim()
    .toLowerCase()
    .replace(/^(?:please |can you |could you )+/, '')
    .replace(/(?:,?\s+please)?[.!?]*$/, '')
    .split(/(?:\s*,\s*(?:(?:and|then)\s+)?|\s+(?:and then|and|then)\s+|[.;]\s*)/);
  const install =
    /^(?:pnpm (?:i|install)|(?:use pnpm to )?install (?:the |its |project )?(?:deps|dependencies)(?: (?:with|using) pnpm)?)$/;
  const launch =
    /^(?:(?:run|start|launch|open|preview) (?:the |this |my |our |its |a )?(?:(?:vite|next(?:\.js)?) )?(?:(?:app|project|dev|development) )?(?:app(?:lication)?|project|server|preview|it)(?: (?:locally|in (?:the )?(?:browser|chrome)))?|(?:run )?pnpm (?:run )?dev)$/;
  return (
    clauses.some((clause) => launch.test(clause)) &&
    clauses.every((clause) => install.test(clause) || launch.test(clause))
  );
}

export function buildTaskBrief(request: string): TaskBrief {
  const goal = tidy(request);
  const firstLine = goal.split(/[\r\n]/).at(0) ?? '';
  const createPrefix =
    /^(?:please\s+)?(?:can you\s+)?(?:make|build|create|implement|develop)\s+(?:me\s+)?(?:like\s+)?(?:(?:a|an|the)\s+)?/i;
  const changePrefix =
    /^(?:please\s+)?(?:can you\s+)?(?:fix|repair|debug|change|update|refactor|remove|improve|add)\s+/i;
  const changeExisting = changePrefix.test(firstLine);
  const lead = firstLine
    .replace(createPrefix, '')
    .replace(/[.!?]+$/, '')
    .trim();
  // Classify the requested subject. References to a game in a later clause
  // or line can be context for an unrelated change.
  const [subject = ''] = lead
    .replace(changePrefix, '')
    .replace(/^(?:a|an|the|my|our)\s+/i, '')
    .split(/[,;:.!?]|\s+(?:with|for|in|of|using|where|that|to)\b/i, 1);
  const gameName = subject.trim().replace(/^(?:(?:simple|classic|browser|web|skeuomorphic)\s+)+/i, '');
  let kind: TaskBrief['kind'] = 'general';
  if (/^(?:tic[ -]?tac[ -]?toe|noughts\s+and\s+crosses)(?: game)?$|^xo game$/i.test(gameName)) {
    kind = 'tic-tac-toe';
  } else if (/^(?:colou?r[ -]?(?:order[ -]?)?memory(?: game)?|memory[ -]sequence game)$/i.test(gameName)) {
    kind = 'color-memory';
  }
  const game = kind !== 'general' || (createPrefix.test(firstLine) && /^(?:[\w-]+\s+)?game$/i.test(gameName));
  let name = 'New task';

  if (!changeExisting && kind === 'tic-tac-toe') {
    name = 'Tic-tac-toe';
  } else if (!changeExisting && kind === 'color-memory') {
    name = 'Color Memory';
  } else if (lead) {
    name = lead.charAt(0).toUpperCase() + lead.slice(1);
  }

  const approach = [
    'Inspect the project first. Preserve existing work and follow its stack and conventions.',
    'Turn the request into a small, concrete implementation plan. Keep the requested style and features; ' +
      'do not add unrelated scope.',
    'Implement, inspect the saved result, run available approved checks, and repair failures before ' +
      'requesting completion.',
  ];
  const quality = [
    'Every visible control has a purpose and works; show loading, empty, error and finished states ' +
      'where relevant.',
    'Use familiar navigation and labels, readable contrast, keyboard focus and responsive layouts. ' +
      'Keep advanced controls out of the main path.',
    'Report what was actually verified and what was not. ' +
      'A source read-back is not a browser interaction test.',
  ];
  const defaults = [
    'The original request overrides these defaults. Choose reversible details without asking; ' +
      'ask only for a consequential unresolved decision.',
    'Do not add accounts, analytics, backend services, package installs or network access unless ' +
      'the task genuinely requires them and permissions allow it.',
  ];

  if (game && !changeExisting) {
    defaults.push(
      'For a new, empty browser-game project with no requested framework, prefer ' +
        'index.html, styles.css and script.js, opening directly in the browser. Keep an existing or ' +
        'explicitly requested stack instead.',
    );
  }

  if (kind === 'tic-tac-toe') {
    if (changeExisting) {
      approach.push(
        'For the requested change, preserve the existing game rules and verify the ' +
          'affected turn, win/draw and restart behavior. Do not rebuild unrelated features.',
      );
    } else {
      approach.push(
        'Cover a 3×3 board, X/O turns, occupied-cell protection, every winning line, ' +
          'a draw, and restart. Prevent further moves after a finished game.',
      );
      defaults.push(
        'Unless the request says otherwise, use two local players. Do not invent ' +
          'online play or an AI opponent.',
      );
    }

    quality.push(
      'Check win, draw and restart logic. Include pointer/touch input and ' +
        'keyboard-accessible cells with an unambiguous turn/result indicator.',
    );
  } else if (kind === 'color-memory' && !changeExisting) {
    approach.push(
      'Cover sequence playback, input locked during playback, correct-order input, ' +
        'sequence growth, score, mistake/game-over and restart.',
    );
    quality.push(
      'Check that restart cancels old timers and that input cannot leak between playback ' +
        'and the player’s turn.',
    );
  }

  if (game && /skeuomorph|skumorph|skewmorph|skeumorph|skewmr/i.test(subject)) {
    quality.push(
      'Use restrained skeuomorphism: tactile bevels, inset surfaces, subtle highlights ' +
        'and real pressed states. Materials support readability; do not bury the game in ornamental panels.',
    );
  }

  return { title: clipWords(name, 50), kind, approach, quality, defaults };
}

export function suggestedTaskName(request: string): string {
  return buildTaskBrief(request).title;
}

/** Repair display-only legacy auto-titles; never rename an explicit user title. */
export function displayTaskName(task: { name: string; goal: string }): string {
  const cleaned = tidy(task.name);
  const goal = tidy(task.goal);
  const firstLine = goal.split('\n').at(0) ?? '';

  if (cleaned === firstLine.slice(0, 55) || cleaned === firstLine.slice(0, 60)) {
    return suggestedTaskName(goal);
  }

  if (cleaned) {
    return cleaned;
  }

  return suggestedTaskName(goal);
}

export function taskBriefText(goal: string): string {
  const brief = buildTaskBrief(goal);

  return [
    'MITTER BUILD BRIEF (local template; subordinate to the original request)',
    'APPROACH',
    ...brief.approach.map((step) => '- ' + step),
    'QUALITY BAR',
    ...brief.quality.map((item) => '- ' + item),
    'DEFAULTS, NOT ADDITIONAL REQUIREMENTS',
    ...brief.defaults.map((item) => '- ' + item),
    'PROGRESS AND STOPPING',
    '- Use the batch summary to say what this step does and what remains. Continue concrete work ' +
      'rather than repeatedly expanding the plan.',
    '- Fix reported failures, then request finish once the requested behavior is implemented. ' +
      'Do not keep polishing forever or invent features to fill turns.',
    '- The checklist above is guidance. The host separately enforces configured checks and applicable ' +
      'built-in quality gates. Read the observed completion evidence: no separate acceptance click is ' +
      'required, and untested behavior must not be described as verified.',
    '- Never claim browser, audio, build or test success without the corresponding execution evidence. ' +
      'No browser-testing tool is implied by this brief.',
  ].join('\n');
}
