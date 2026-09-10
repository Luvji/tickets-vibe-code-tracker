const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockVscode(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const { shouldRestoreLinkPlaceholder, selectionsContainLine } = require('./extension').__test;
const {
  formatTrackerTitle,
  ensureTrackerHeader,
  getNotificationSidecarPath,
  buildTicketSummary,
  findHierarchyNotifications,
  normalizeTicketDocument,
  ensureNotificationMarker,
  ensureInfoMarker
} = require('./ticketFlow');

assert.equal(
  formatTrackerTitle('customer-portal'),
  'CUSTOMER PORTAL - DEVELOPMENT TRACKER',
  'tracker titles must be derived from a readable project name'
);

const generatedHeader = ensureTrackerHeader(
  '*- [EPIC][APP-0001] Planned Delivery\n',
  { prefix: 'APP', projectName: 'customer-portal' }
);
assert.match(
  generatedHeader.text,
  /^\[HELP\] Hover here for ticket rules and conventions\.\n\[NOTIFICATION\] No active ticket notifications\.\n\[INFO\] Hover here for the current ticket summary\.\n\[PREFIX: APP\]\n={80}\nCUSTOMER PORTAL - DEVELOPMENT TRACKER\n={80}\n\n\*- \[EPIC\]/,
  'every tracker must receive the complete standard project-aware header'
);

const customizedHeader = ensureTrackerHeader(
  '[INFO] moved\n[PREFIX: OWN]\n' +
  '='.repeat(80) + '\nRelease Readiness Board\n' + '='.repeat(80) + '\n' +
  '[*NOTIFICATION] Review this\n[HELP] moved\n\n~- [EPIC][OWN-0001] Review\n',
  { prefix: 'IGNORED', projectName: 'different-project' }
);
assert.match(
  customizedHeader.text,
  /^\[HELP\].*\n\[\*NOTIFICATION\].*\n\[INFO\].*\n\[PREFIX: OWN\]\n={80}\nRelease Readiness Board\n={80}\n\n~- \[EPIC\]/,
  'normalization must reorder protected markers while preserving user title and prefix changes'
);
assert.equal((customizedHeader.text.match(/Release Readiness Board/g) || []).length, 1,
  'a preserved custom tracker title must not be duplicated');

assert.equal(
  getNotificationSidecarPath('/workspace/tasks/development.tkt', '/workspace'),
  '/workspace/.tickets/notifications/tasks/development.tkt.notification',
  'a .tkt tracker must map into the workspace ticket-support folder'
);
assert.equal(
  getNotificationSidecarPath('/workspace/other/development.tkt', '/workspace'),
  '/workspace/.tickets/notifications/other/development.tkt.notification',
  'same-named trackers in different folders must retain unique mirrored paths'
);
assert.equal(
  getNotificationSidecarPath('/workspace/bugs.tickets', '/workspace'),
  '/workspace/.tickets/notifications/bugs.tickets.notification',
  'a .tickets tracker must map to a unique notification record'
);

const changedLine = new Set([4]);
const unchangedLine = new Set();

assert.equal(shouldRestoreLinkPlaceholder('  [LINK]', 4, changedLine), false,
  'must not restore the placeholder during an edit on the LINK line');
assert.equal(shouldRestoreLinkPlaceholder('  [LINK]', 4, unchangedLine), true,
  'must restore the placeholder after editing leaves an empty LINK line');
assert.equal(shouldRestoreLinkPlaceholder('  [LINK]   ', 4, unchangedLine), true,
  'must treat whitespace-only payloads as empty');
assert.equal(shouldRestoreLinkPlaceholder('  [LINK]{nil}', 4, unchangedLine), false,
  'must not duplicate the unresolved placeholder');
assert.equal(shouldRestoreLinkPlaceholder('  [LINK][ARR-0002]', 4, unchangedLine), false,
  'must preserve complete references');
assert.equal(shouldRestoreLinkPlaceholder('  [LINK][ARR-', 4, unchangedLine), false,
  'must preserve partial references instead of prepending {nil}');
assert.equal(shouldRestoreLinkPlaceholder('  [DESC]', 4, unchangedLine), false,
  'must ignore non-LINK lines');

assert.equal(selectionsContainLine([{ start: { line: 4 }, end: { line: 4 } }], 4), true,
  'caret movement on the edited line must keep the edit session active');
assert.equal(selectionsContainLine([{ start: { line: 5 }, end: { line: 5 } }], 4), false,
  'moving away from the edited line must finish the edit session');
assert.equal(selectionsContainLine([{ start: { line: 3 }, end: { line: 5 } }], 4), true,
  'a selection spanning the edited line must keep the edit session active');

const orphanResult = normalizeTicketDocument(
  '[HELP] Hover here\n#- [BUG][APP-0001] Orphan bug\n[DESC] Original detail\n',
  { prefix: 'APP', nextId: 2, padding: 4, ticketIndentation: 4, descriptionIndentation: 2 }
);
assert.equal(orphanResult.generatedEpic, true, 'must generate an epic for tickets that precede every epic');
assert.match(orphanResult.text, /~- \[EPIC\]\[APP-0002\] Uncategorized Work Requiring Review/,
  'generated grouping epic must use the next project ID');
assert.match(orphanResult.text, /\n\n~- \[EPIC\]\[APP-0002\] Uncategorized Work Requiring Review\n\n    #- \[BUG\]\[APP-0001\]/,
  'epic boundaries and direct child indentation must be restored');
assert.match(orphanResult.text, /\n      \[DESC\] Original detail\n$/,
  'ticket descriptions must use the configured extra indentation');
assert.equal(orphanResult.notifications[0].code, 'needs-grouping',
  'a generated holding epic must require semantic review');

const siblingResult = normalizeTicketDocument(
  '~- [EPIC][APP-0001] Delivery\n@- [FT][APP-0002] Parent\n@- -- [SUB][APP-0003] First child\n@- -- [SUB][APP-0004] Second child\n',
  { ticketIndentation: 4, descriptionIndentation: 2 }
);
assert.match(siblingResult.text, /\n    @- \[FT\]\[APP-0002\] Parent\n        @- -- \[SUB\]\[APP-0003\] First child\n        @- -- \[SUB\]\[APP-0004\] Second child\n$/,
  'repeated -- children must remain siblings beneath the same parent');
assert.deepEqual(findHierarchyNotifications(siblingResult.text, { ticketIndentation: 4 }), [],
  'valid nested siblings beneath an epic must not create notifications');

const customIndentResult = normalizeTicketDocument(
  '~- [EPIC] Custom spacing\n[DESC] Epic detail\n*- [ENH] Child\n[DESC] Child detail',
  { ticketIndentation: 3, descriptionIndentation: 1, numberingEnabled: false }
);
assert.match(customIndentResult.text, /~- \[EPIC\] Custom spacing\n \[DESC\] Epic detail\n\n   \*- \[ENH\] Child\n    \[DESC\] Child detail$/,
  'epic descriptions must precede the boundary while custom indentation is honored');

const multipleEpicDescriptions = normalizeTicketDocument(
  '~- [EPIC] Documented epic\n\n[DESC] First detail\n\n[DESC] Second detail\n@- [FT] Child ticket\n',
  { ticketIndentation: 4, descriptionIndentation: 2, numberingEnabled: false }
);
assert.equal(
  multipleEpicDescriptions.text,
  '~- [EPIC] Documented epic\n  [DESC] First detail\n  [DESC] Second detail\n\n    @- [FT] Child ticket\n',
  'epic descriptions must follow the epic directly with exactly one blank line after the final description'
);

const activeMarker = ensureNotificationMarker(orphanResult.text, true);
assert.match(activeMarker.text, /^\[HELP\].*\n\[\*NOTIFICATION\]/,
  'active structural concerns must create an active marker after HELP');
const preservedMarker = ensureNotificationMarker(activeMarker.text, false);
assert.match(preservedMarker.text, /^\[HELP\].*\n\[\*NOTIFICATION\]/,
  'an AI-authored active marker must remain active until explicitly resolved');
const inactiveMarker = ensureNotificationMarker('[HELP] Hover here\n', false);
assert.match(inactiveMarker.text, /^\[HELP\].*\n\[NOTIFICATION\]/,
  'clean files must receive an inactive marker');

const infoMarker = ensureInfoMarker('[HELP] Hover here\n[*NOTIFICATION] Review this\n');
assert.match(infoMarker.text, /^\[HELP\].*\n\[\*NOTIFICATION\].*\n\[INFO\] Hover here for the current ticket summary\./,
  'the protected INFO marker must be restored directly after the notification marker');

const summary = buildTicketSummary(
  '~- [EPIC][APP-0001] First Epic\n' +
  '  [DESC] First epic details\n\n' +
  '    $- [FT][APP-0002] Completed Parent\n' +
  '      [DESC] Parent details\n' +
  '        -- [SUB][APP-0003] Inherited Child\n' +
  '    @- [BUG][APP-0004] Active Bug\n\n' +
  '*- [EPIC][APP-0005] Second Epic\n\n' +
  '    [TEST][APP-0006] Planned Test\n',
  { ticketIndentation: 4 }
);
assert.equal(summary.epicCount, 2, 'INFO summary must count epics');
assert.equal(summary.ticketCount, 4, 'INFO summary must count non-epic tickets');
assert.equal(summary.statusCounts.$, 2, 'nested tickets without a status must inherit their parent status');
assert.equal(summary.statusCounts['@'], 1, 'INFO summary must count active tickets');
assert.equal(summary.statusCounts['*'], 1, 'direct tickets without a status must inherit their epic status');
assert.equal(summary.epics[0].tickets[1].depth, 1, 'INFO summary must retain nested ticket depth');
assert.deepEqual(summary.epics[0].tickets[0].descriptions, ['Parent details'],
  'INFO summary must include ticket descriptions');
assert.deepEqual(summary.epics[0].descriptions, ['First epic details'],
  'INFO summary must include epic descriptions');

const aiPrompt = fs.readFileSync('README.md', 'utf8');
assert.match(aiPrompt, /Never treat elapsed calendar time, file age, or a long period of project inactivity as evidence/i,
  'AI guidance must prohibit time-based completion decisions');
assert.match(aiPrompt, /Do not change the ticket to `\$-` during that first reminder/i,
  'AI guidance must notify before considering automatic completion');
assert.match(aiPrompt, /If the reminder is still present in a later active work session, re-run the relevant tests/i,
  'AI guidance must require fresh verification in a later active session');
assert.match(aiPrompt, /Never read or write another tracker's notification record for the current marker/i,
  'AI guidance must isolate notification history by ticket file');
assert.match(aiPrompt, /Store newly created ticket-specific evidence images[\s\S]*under `\.tickets\/evidence\/<ticket-id>\/`/i,
  'AI guidance must route ticket support artifacts into the dedicated support folder');
assert.match(aiPrompt, /Keep the standard top block in every ticket tracker[\s\S]*Preserve a title the user has changed/i,
  'AI guidance must maintain a project-aware standard header without overwriting user titles');
assert.match(aiPrompt, /When no substantial work is currently underway[\s\S]*do not repeat the reminder in every response/i,
  'AI guidance must surface planned work only at contextually appropriate moments');

console.log('All ticket flow regression tests passed.');
