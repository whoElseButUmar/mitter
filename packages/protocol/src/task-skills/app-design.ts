export { APP_COMPONENTS_JS } from './app-components.js';

export const APP_DESIGN_GUIDANCE: string = `Apply to requested interfaces; do not add UI to backend tasks.
Choose layout, density and primary actions for the audience and workflow. Use shared theme tokens and reusable controls. Fit content, long titles and empty states; group related controls with alignment and spacing. Keep a clear hierarchy and recognizable actions.
Avoid generic hero/card grids, tiny secondary text or unnecessary decoration. Motifs, colors and fonts should fit the product and brand; replacing one mandatory template with another defeats that purpose.
Mount a visible main landmark and heading in the initial HTML, before scripts or API calls. For example, <div id="app"><main><h1>Orders</h1><p class="ui-loading" role="status">Loading orders…</p></main></div>. Use the actual screen name. Preserve the shell on navigation, including while awaiting data. On refresh keep existing records visible, mark their region aria-busy="true" and announce progress in a sibling role="status". Keep text, rows, headers and ancestors at full opacity. Use an indicator beside the status if needed. Clear the status and busy flag on success or error.
Adapt the foundation to the existing stack. Use shadcn/Radix as interaction references, not a requirement to install React or dependencies. Audit visible copy before finishing. On utility screens follow the page title with controls or records. Omit site-role labels beside the brand, page introductions summarizing the tool, footer explanations of the workflow and routine storage notices. Keep help where it affects a decision, requested wording, navigation, credits, privacy settings, constraints, actual save feedback and errors. Show each record’s status once, including after actions. Give an empty state one label. Add a second line for a new action, reason or constraint. Write promotional or editorial copy only to the extent explicitly requested.
Icons, arrows, badges and accents need a clear action, hierarchy or state meaning. Remove redundant helper paragraphs and decorative status dots. Status, counts, metrics, testimonials and save/connectivity/success messages must come from real state; label demonstration data clearly. Never imply an operation succeeded before it did. Pair semantic color with text or another non-color cue.
Style controls and their open surfaces. Keep native inputs, textareas, selects, buttons and visible labels. Preserve autocomplete, paste, selection, editing, validation and submission. Set button types and link errors after interaction with aria-describedby and aria-invalid. Use CSS :focus-visible for one 2px ring, without JavaScript modality tracking or blanket outline removal. A wrapper ring must follow its child with :has(:focus-visible), not blanket :focus-within; retain the child's ring as the fallback and suppress it only where the visible wrapper ring replaces it. Text inputs can match :focus-visible after mouse focus too.
Name text buttons from their visible words. For a row action, createActionButton("Mark ready", record.name) keeps the visible label intact and appends visually hidden context. In other stacks append the record in a .ui-sr-only span after the full label. For an icon-only button put the action in aria-label on the button and aria-hidden="true" on the icon.
Provide themed components for other controls used by the app, including checkboxes, radios, switches, range sliders, file uploads and number steppers; do not apply text-field sizing to every input type. For quantities, retain type="number", min/max/step, numeric editing, ArrowUp/ArrowDown and validation. The foundation removes the native spinner with appearance:textfield and WebKit spin-button overrides; add labeled, styled increase/decrease buttons only when needed. Do not intercept ordinary editing keys to hide browser chrome. For numeric identifiers, use a text input with an appropriate inputmode instead. Dialogs need a name, sensible initial focus, contained modal focus, Escape and focus return; tooltips must work on focus and never hold essential instructions. Position popovers at their trigger with collision handling and keep menus usable at zoom.
Use an accessible select primitive already in the stack, or feature-detect customizable native select with appearance:base-select and ::picker(select). The CSS fallback styles the trigger but cannot theme every OS popup: where a styled popup is required on unsupported browsers, supply an accessible component. Inset the chevron with logical padding and inset-inline-end; reserve room for long labels and RTL. Custom widgets need names, expanded/selected/disabled state, keyboard navigation, typeahead for select choices, Escape dismissal and focus return. Follow the WAI-ARIA combobox pattern; CSS classes alone do not provide behavior.
Do not use native datalist/input[list] suggestion popups: their browser-owned surface cannot meet the shared styling and accessibility contract. Use the stack's styled accessible combobox with a labeled input, associated listbox, expanded/active-option state and keyboard selection, or keep a plain text input when suggestions are optional. Do not disable browser autofill or password managers merely to imitate a custom suggestion menu.
For forms with themed controls, keep required and server-side validation. Present invalid submissions with styled, specific text linked to the affected field and move focus there. Suppress the browser validation popup when presenting the app’s own feedback.
When dates are relevant, provide a reusable styled calendar and labeled trigger/input; add ranges and presets only when the task needs them. Preserve manual date entry, local-date parsing (no UTC day shifts), min/max bounds and range order. Let input/trigger pairs wrap within their container; keep the full date readable in narrow columns even on wide screens. If one input cannot fit, widen or stack the parent columns. Support arrow/Home/End/PageUp/PageDown navigation, Enter/Space selection, announced month/selection, Escape and focus return. Keep the active day and selected date distinct.
The foundation automatically themes the document scrollbar and every scroll container within .ui, including textareas and containers without .ui-scroll. Keep native wheel, touch and keyboard scrolling. It uses thin native scrollbars, a stable document gutter, a WebKit fallback and wider controls for coarse pointers or high contrast. Keep thumb contrast at least 3:1 against both track and surface. Give an otherwise unreachable region tabindex=0 and an accessible name. Custom overflow containers need a containing block, usually position:relative, so absolutely positioned visually hidden labels stay inside the scroll area. Check a wide table with a hidden Actions heading at narrow widths: the table must scroll without expanding the page, and the heading must remain accessible. A dialog uses a clipped rounded shell, fixed header/footer and a scrolling body; never put the scrollbar on the entire modal or cover its corners. Scroll containment on non-scrollable dialog/backdrop surfaces is progressive enhancement, not a guarantee on every browser. Verify narrow screens, zoom, RTL, disabled/error states, keyboard flow, forced colors and reduced motion.
Target WCAG 2.2 AA: meaningful landmarks and heading order, text alternatives, readable contrast, keyboard access, visible unobscured focus, adequate target size/spacing, reflow and announced errors/status. Test the actual populated, empty, loading, rejected and recovery states the app supports, including long content. Check mouse and keyboard journeys at desktop and narrow viewport widths and inside narrow containers. Include opening/closing controls, Escape, focus return, validation, scrolling and persistence where relevant. Inspect rendered results for clipped text, collisions, unreachable controls and misleading emphasis. Do not hide overflow, suppress errors or remove required features to pass checks. Automated scores cannot establish complete accessibility conformance or visual quality; record what was exercised and any remaining manual checks.
Foundation usage: for a full-page app put .ui on <html> so theme tokens also reach the document scrollbar; keep popup portals inside it. For an embedded app, put .ui on its themed root and set document scrollbar tokens on :root if the surrounding page uses a different theme. Apply .ui-control to text inputs, textareas and select triggers; .ui-button to buttons (data-variant="primary" for the primary action). Wrap a select or custom trigger in .ui-select. Use .ui-popup for popup surfaces, .ui-option for choices, .ui-calendar for a seven-column day grid and .ui-day for its buttons; expose selected state with aria-selected or aria-pressed as appropriate. .ui-scroll establishes a containing block with position:relative, overflow:auto and a stable gutter; constrain its width or height as needed. Scrollbar styling does not require that class. Use .ui-error for linked error text. Override tokens once for the app theme; preserve contrast and accessible behavior.
Copy the bundled controls with {"type":"write","path":"components.mjs","asset":"components.mjs","base":"missing"} and their CSS with {"type":"write","path":"foundation.css","asset":"foundation.css","base":"missing"}. For existing destination files, read them and supply the usual version base. Miter supplies the exact source bytes and checks the expanded batch limit. Link the stylesheet and import the controls your app uses. Import createDatePicker(input,{min,max,onChange,returnFocus}) for a labeled text input: it adds a themed calendar dialog with keyboard navigation, bounded local dates and Today. Its controller exposes open(), close(), validate(), setBounds({min,max}), setDisabled(boolean), dispose(). Pair two date pickers and update bounds for ranges; validate order again at submission. createTimeInput(input,{onChange}) keeps a labeled text field in 24-hour HH:mm format; expose that format in visible field help. It returns validate() and dispose(). Neither uses native date/time popup UI. Call validate() after programmatic value changes and before saving; link visible error text. Dispose controllers before replacing their nodes.
Use a native <dialog class="ui-dialog" aria-labelledby="title-id"> containing .ui-dialog-header, .ui-dialog-body.ui-scroll and .ui-dialog-footer, in that order. The body gets tabindex="0" and an accessible name if it needs its own keyboard scroll stop. createDialog(dialog,{initialFocus:()=>element,returnFocus:()=>element}) exposes open(trigger), close(value), dispose(); it uses showModal(), native Escape/focus containment, and resolves focus return after close handlers and promise callbacks. Give rerendered openers stable IDs, supply a returnFocus resolver, or mark a persistent focusable fallback with data-dialog-fallback. confirmAction({root,title,message,confirmLabel,trigger,returnFocus}) returns Promise<boolean> and initially focuses Cancel. All portals stay in the connected .ui root. parseLocalDate(value), formatLocalDate(date) and shiftCalendarMonth(date,amount) are also exported.
Use these modules or equivalent accessible controls in the app’s stack. Read engineering-quality for the miter.quality.json contract. Link styles and components, test domain behavior, and exercise the main workflow, invalid input, persistence and keyboard dialogs when present. Target real controls and assert visible results. Miter runs journeys with fresh storage on desktop and mobile and returns source, domain, browser and Lighthouse failures for repair within budget. Keep features and truthful states while reaching 100 in each scored category. Report what passed and any remaining manual review.`;

export const APP_FOUNDATION_CSS: string = `.ui {
  --ui-bg:#fff; --ui-text:#18212f; --ui-border:#758194;
  --ui-accent:#2856c7; --ui-on-accent:#fff; --ui-hover:#e9eef7; --ui-error:#b42318;
  --ui-scroll-thumb:#6b778a; --ui-scroll-track:#fff;
  --ui-radius:.625rem; color:var(--ui-text); background:var(--ui-bg); color-scheme:light;
  font:1rem/1.5 system-ui,sans-serif; accent-color:var(--ui-accent);
}
.ui *, .ui *::before, .ui *::after { box-sizing:border-box; }
.ui :where(input,textarea,select,button) { font:inherit; color:inherit; }
.ui :where(.ui-control,.ui-button,.ui-option,.ui-day) {
  min-block-size:2.75rem; border:1px solid var(--ui-border); border-radius:var(--ui-radius);
  padding:.55rem .75rem; background:var(--ui-bg); box-shadow:none;
}
.ui .ui-control { inline-size:100%; min-inline-size:0; }
.ui textarea.ui-control { resize:vertical; }
.ui input[type="number"] { appearance:textfield; }
.ui input[type="number"]::-webkit-inner-spin-button,
.ui input[type="number"]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
.ui :where(.ui-button,.ui-option,.ui-day) { cursor:pointer; }
.ui :where(.ui-button,.ui-option,.ui-day):where(:hover:not(:disabled):not([aria-disabled="true"])) { background:var(--ui-hover); }
.ui :where(.ui-button,.ui-option,.ui-day):active:not(:disabled):not([aria-disabled="true"]) { filter:brightness(.94); }
.ui :where([data-variant="primary"],.ui-option[aria-selected="true"],.ui-day[aria-selected="true"],.ui-day[aria-pressed="true"]) {
  background:var(--ui-accent); color:var(--ui-on-accent); border-color:var(--ui-accent);
}
.ui :where(:disabled,[aria-disabled="true"]) { opacity:.6; cursor:not-allowed; }
.ui :where(.ui-control[aria-invalid="true"],.ui-control:user-invalid) { border-color:var(--ui-error); }
.ui .ui-error { color:var(--ui-error); }
.ui .ui-loading { color:var(--ui-text); background:var(--ui-bg); }
.ui :where(a,button,input,textarea,select,summary,[tabindex]):focus-visible {
  outline:2px solid var(--ui-accent); outline-offset:2px; box-shadow:none;
}
.ui .ui-select { position:relative; }
.ui .ui-select > .ui-control { appearance:none; padding-inline-end:2.5rem; text-align:start; }
.ui .ui-select::after {
  content:""; position:absolute; pointer-events:none; inset-inline-end:1rem; inset-block-start:calc(50% - .35rem);
  inline-size:.5rem; block-size:.5rem; border-right:2px solid; border-bottom:2px solid; transform:rotate(45deg);
}
.ui .ui-popup { padding:.375rem; color:var(--ui-text); background:var(--ui-bg); border:1px solid var(--ui-border); border-radius:var(--ui-radius); }
.ui .ui-option { display:block; inline-size:100%; text-align:start; }
.ui .ui-calendar { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:.25rem; }
.ui .ui-calendar-row { display:contents; }
.ui .ui-weekday { text-align:center; font-size:.8rem; padding-block:.5rem; }
.ui .ui-day { padding:.25rem; }
.ui .ui-day[data-outside="true"] { border-style:dashed; }
.ui .ui-day[aria-current="date"] { border-width:2px; font-weight:700; }
.ui .ui-calendar-nav { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.5rem; margin-block-end:.5rem; }
.ui .ui-calendar-month { text-align:center; font-weight:600; }
.ui .ui-date-field { display:flex; flex-wrap:wrap; align-items:start; gap:.5rem; }
.ui .ui-date-field > .ui-control {
  flex:1 1 calc(10ch + 1.5rem + 2px); inline-size:auto;
  min-inline-size:min(100%,calc(10ch + 1.5rem + 2px)); font-variant-numeric:tabular-nums;
}
.ui .ui-date-field > .ui-button { flex:0 0 auto; max-inline-size:100%; }
.ui .ui-dialog {
  padding:0; inline-size:min(36rem,calc(100vw - 2rem)); max-block-size:calc(100vh - 2rem);
  max-block-size:calc(100dvh - 2rem); color:var(--ui-text); background:var(--ui-bg);
  border:1px solid var(--ui-border); border-radius:var(--ui-radius); overflow:hidden;
}
.ui .ui-dialog[open] { display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
.ui .ui-dialog:modal { overscroll-behavior:contain; }
.ui .ui-dialog::backdrop { background:rgb(15 23 42 / .45); overflow:hidden; overscroll-behavior:contain; }
.ui .ui-dialog-header, .ui .ui-dialog-footer { display:flex; align-items:center; gap:.75rem; padding:1rem; }
.ui .ui-dialog-header { justify-content:space-between; border-block-end:1px solid var(--ui-border); }
.ui .ui-dialog-header h2 { margin:0; font-size:1.125rem; }
.ui .ui-dialog-footer { justify-content:flex-end; flex-wrap:wrap; border-block-start:1px solid var(--ui-border); }
.ui .ui-dialog-body { min-block-size:0; overflow:auto; padding:1rem; overscroll-behavior:contain; }
.ui .ui-date-dialog { inline-size:min(28rem,calc(100vw - 2rem)); }
:root, .ui, .ui * { scrollbar-width:thin; scrollbar-color:var(--ui-scroll-thumb,#6b778a) var(--ui-scroll-track,#fff); }
:root { scrollbar-gutter:stable; }
.ui .ui-scroll { position:relative; overflow:auto; scrollbar-gutter:stable; }
.ui .ui-sr-only { position:absolute; inline-size:1px; block-size:1px; margin:-1px; padding:0; border:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@supports not (scrollbar-color:auto) {
  :is(:root,.ui,.ui *)::-webkit-scrollbar { width:6px; height:6px; }
  :is(:root,.ui,.ui *)::-webkit-scrollbar-thumb { background:var(--ui-scroll-thumb,#6b778a); border-radius:999px; }
  :is(:root,.ui,.ui *)::-webkit-scrollbar-track { background:var(--ui-scroll-track,#fff); }
}
@supports (appearance:base-select) and selector(::picker(select)) {
  .ui .ui-select > select.ui-control, .ui .ui-select > select.ui-control::picker(select) { appearance:base-select; }
  .ui .ui-select select::picker-icon { display:none; }
  .ui .ui-select select::picker(select) { padding:.375rem; background:var(--ui-bg); color:var(--ui-text); border:1px solid var(--ui-border); border-radius:var(--ui-radius); scrollbar-width:inherit; scrollbar-color:inherit; }
  .ui .ui-select option { padding:.55rem .75rem; }
  .ui .ui-select option:checked { background:var(--ui-accent); color:var(--ui-on-accent); }
}
@media (prefers-contrast:more), (pointer:coarse) {
  :root, .ui, .ui * { --ui-scroll-thumb:var(--ui-text,#18212f); scrollbar-width:auto; }
  :is(:root,.ui,.ui *)::-webkit-scrollbar { width:12px; height:12px; }
}
@media (forced-colors:active) {
  .ui { --ui-bg:Canvas; --ui-text:CanvasText; --ui-border:ButtonText; --ui-accent:Highlight; --ui-on-accent:HighlightText; --ui-hover:Canvas; --ui-error:CanvasText; --ui-scroll-thumb:CanvasText; --ui-scroll-track:Canvas; }
  :root, .ui, .ui * { --ui-scroll-thumb:CanvasText; --ui-scroll-track:Canvas; scrollbar-color:auto; scrollbar-width:auto; }
  :is(:root,.ui,.ui *)::-webkit-scrollbar { width:12px; height:12px; }
  .ui :where(:disabled,[aria-disabled="true"]) { opacity:1; color:GrayText; }
}
@media (max-width:24rem) {
  .ui .ui-calendar-nav { column-gap:.25rem; }
  .ui .ui-calendar-nav .ui-button { padding-inline:.4rem; }
  .ui .ui-dialog-header, .ui .ui-dialog-footer, .ui .ui-dialog-body { padding:.75rem; }
}
@media (prefers-reduced-motion:reduce) {
  .ui *, .ui *::before, .ui *::after { animation:none; transition:none; scroll-behavior:auto; }
}`;
