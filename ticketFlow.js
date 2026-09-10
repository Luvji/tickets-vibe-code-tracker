const TICKET_TAGS = 'BUG|B|FT|F|ENH|ENHANCEMENT|E|EPIC|EP|SUB|TEST';
const TICKET_LINE_REGEX = new RegExp(
  `^(\\s*)(?:([$@#*!^~])-\\s*)?(?:(--+)\\s*)?\\[(${TICKET_TAGS})\\]`,
  'i'
);
const STATUS_ORDER = ['$', '@', '#', '*', '!', '^', '~', '?'];
const STATUS_LABELS = {
  '$': 'Completed',
  '@': 'In Progress',
  '#': 'Ready to Test',
  '*': 'Planned',
  '!': 'Cancelled',
  '^': 'Failed / Rework',
  '~': 'Undecided',
  '?': 'Unspecified'
};
const HEADER_SEPARATOR = '='.repeat(80);
const HELP_MARKER = '[HELP] Hover here for ticket rules and conventions.';
const INFO_MARKER = '[INFO] Hover here for the current ticket summary.';

function clampInteger(value, fallback, minimum = 0, maximum = 16) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function formatTrackerTitle(projectName) {
  const readableName = String(projectName || 'Project')
    .replace(/\.(?:tickets|tkt)$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Project';
  return `${readableName.toUpperCase()} - DEVELOPMENT TRACKER`;
}

function findExistingHeaderFrame(lines) {
  const limit = Math.min(lines.length - 2, 40);
  for (let index = 0; index < limit; index++) {
    if (!/^={20,}\s*$/.test(lines[index])) continue;
    if (!lines[index + 1].trim() || !/^={20,}\s*$/.test(lines[index + 2])) continue;
    return {
      indices: new Set([index, index + 1, index + 2]),
      title: lines[index + 1].trim()
    };
  }
  return null;
}

function ensureTrackerHeader(text, options = {}) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const existingFrame = findExistingHeaderFrame(lines);
  const existingPrefix = lines
    .map(line => line.match(/^\s*\[PREFIX:\s*([A-Za-z0-9_-]+)\]\s*$/i))
    .find(Boolean);
  const activeAlready = lines.some(line => /^\s*\[\*NOTIFICATION\]/i.test(line));
  const active = options.hasStructuralNotifications || activeAlready;
  const prefix = String(existingPrefix ? existingPrefix[1] : options.prefix || 'TKT').toUpperCase();
  const title = existingFrame ? existingFrame.title : formatTrackerTitle(options.projectName);

  const body = lines.filter((line, index) => {
    if (existingFrame && existingFrame.indices.has(index)) return false;
    if (/^\s*\[HELP\]/i.test(line)) return false;
    if (/^\s*\[\*?NOTIFICATION\]/i.test(line)) return false;
    if (/^\s*\[INFO\]/i.test(line)) return false;
    if (/^\s*\[PREFIX:\s*[A-Za-z0-9_-]+\]\s*$/i.test(line)) return false;
    return true;
  });
  while (body.length && !body[0].trim()) body.shift();

  const notificationMarker = active
    ? '[*NOTIFICATION] Hover here for active ticket notifications.'
    : '[NOTIFICATION] No active ticket notifications.';
  const header = [
    HELP_MARKER,
    notificationMarker,
    INFO_MARKER,
    `[PREFIX: ${prefix}]`,
    HEADER_SEPARATOR,
    title,
    HEADER_SEPARATOR
  ];
  if (body.length) header.push('', ...body);

  let result = header.join(newline);
  if (hadFinalNewline) result += newline;
  return { text: result, changed: result !== text, active, prefix, title };
}

function getNotificationSidecarPath(ticketFilePath, workspaceRootPath) {
  const ticketPath = String(ticketFilePath || '').replace(/\\/g, '/');
  const rawRoot = String(workspaceRootPath || '').replace(/\\/g, '/');
  const rootPath = rawRoot === '/' ? '/' : rawRoot.replace(/\/+$/, '');
  const workspacePrefix = rootPath === '/' ? '/' : `${rootPath}/`;
  const relativePath = ticketPath.startsWith(workspacePrefix)
    ? ticketPath.slice(workspacePrefix.length)
    : ticketPath.split('/').filter(Boolean).pop() || 'tickets.tkt';
  const supportRoot = rootPath === '/' ? '/.tickets' : `${rootPath}/.tickets`;
  return `${supportRoot}/notifications/${relativePath}.notification`;
}

function leadingWidth(line, tabSize) {
  const whitespace = (line.match(/^\s*/) || [''])[0];
  let width = 0;
  for (const character of whitespace) {
    if (character === '\t') width += tabSize - (width % tabSize);
    else width += 1;
  }
  return width;
}

function parseStructuralLine(line, tabSize = 4) {
  const desc = line.match(/^(\s*)\[(DESC|DESCRIPTION)\]/i);
  if (desc) return { kind: 'description', indent: leadingWidth(line, tabSize) };

  const link = line.match(/^(\s*)\[LINK\]/i);
  if (link) return { kind: 'link', indent: leadingWidth(line, tabSize) };

  const ticket = line.match(TICKET_LINE_REGEX);
  if (!ticket) return null;
  const tag = ticket[4].toUpperCase();
  return {
    kind: tag === 'EPIC' || tag === 'EP' ? 'epic' : 'ticket',
    tag,
    status: ticket[2] || null,
    hasSubMarker: Boolean(ticket[3]),
    indent: leadingWidth(line, tabSize)
  };
}

function extractTicketText(line, parsed) {
  const withoutComment = line.split('//')[0].trim();
  const tagPattern = parsed.kind === 'epic' ? '(?:EPIC|EP)' : TICKET_TAGS;
  const prefix = new RegExp(
    `^(?:[$@#*!^~]-\\s*)?(?:--+\\s*)?\\[(?:${tagPattern})\\]\\s*`,
    'i'
  );
  const withoutPrefix = withoutComment.replace(prefix, '');
  const idMatch = withoutPrefix.match(/^\[([A-Za-z][A-Za-z0-9_-]*-\d+)\]\s*/);
  return {
    id: idMatch ? idMatch[1].toUpperCase() : null,
    title: (idMatch ? withoutPrefix.slice(idMatch[0].length) : withoutPrefix).trim() || 'Untitled ticket'
  };
}

function buildTicketSummary(text, options = {}) {
  const ticketIndentation = clampInteger(options.ticketIndentation, 4, 1);
  const statusCounts = Object.fromEntries(STATUS_ORDER.map(status => [status, 0]));
  const epics = [];
  const ungrouped = [];
  let activeEpic = null;
  let ticketStack = [];
  let lastOwner = null;

  text.split(/\r?\n/).forEach((line, lineIndex) => {
    const parsed = parseStructuralLine(line, ticketIndentation);
    if (!parsed) return;

    if (parsed.kind === 'description') {
      if (lastOwner) lastOwner.descriptions.push(line.replace(/^\s*\[(?:DESC|DESCRIPTION)\]\s*/i, '').trim());
      return;
    }

    const content = extractTicketText(line, parsed);
    if (parsed.kind === 'epic') {
      activeEpic = {
        line: lineIndex,
        status: parsed.status || '?',
        id: content.id,
        title: content.title,
        descriptions: [],
        tickets: [],
        statusCounts: Object.fromEntries(STATUS_ORDER.map(status => [status, 0]))
      };
      epics.push(activeEpic);
      ticketStack = [];
      lastOwner = activeEpic;
      return;
    }

    while (ticketStack.length && ticketStack[ticketStack.length - 1].indent >= parsed.indent) {
      ticketStack.pop();
    }
    const inheritedStatus = ticketStack.length
      ? ticketStack[ticketStack.length - 1].status
      : activeEpic ? activeEpic.status : '?';
    const status = parsed.status || inheritedStatus || '?';
    const ticket = {
      line: lineIndex,
      status,
      tag: parsed.tag,
      id: content.id,
      title: content.title,
      descriptions: [],
      depth: Math.max(0, Math.floor(parsed.indent / ticketIndentation) - 1),
      indent: parsed.indent
    };

    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (activeEpic) {
      activeEpic.tickets.push(ticket);
      activeEpic.statusCounts[status] = (activeEpic.statusCounts[status] || 0) + 1;
    } else {
      ungrouped.push(ticket);
    }
    ticketStack.push(ticket);
    lastOwner = ticket;
  });

  return {
    epicCount: epics.length,
    ticketCount: epics.reduce((total, epic) => total + epic.tickets.length, 0) + ungrouped.length,
    statusCounts,
    epics,
    ungrouped,
    statusOrder: STATUS_ORDER,
    statusLabels: STATUS_LABELS
  };
}

function formatGeneratedEpic(prefix, nextId, padding, numberingEnabled) {
  const id = numberingEnabled
    ? `[${prefix}-${String(nextId).padStart(padding, '0')}]`
    : '';
  return `~- [EPIC]${id} Uncategorized Work Requiring Review`;
}

function findHierarchyNotifications(text, options = {}) {
  const ticketIndentation = clampInteger(options.ticketIndentation, 4, 1);
  const lines = text.split(/\r?\n/);
  const notifications = [];
  let activeEpic = null;
  let ticketStack = [];

  lines.forEach((line, index) => {
    const parsed = parseStructuralLine(line, ticketIndentation);
    if (!parsed) return;

    if (parsed.kind === 'epic') {
      activeEpic = { line: index, text: line.trim() };
      ticketStack = [];
      if (/\b(?:Needs Grouping|Uncategorized Work Requiring Review)\b/i.test(line)) {
        notifications.push({
          code: 'needs-grouping',
          line: index,
          message: `Generated epic on line ${index + 1} still needs a relevant project-specific name and review.`
        });
      }
      return;
    }

    if (parsed.kind !== 'ticket') return;
    if (!activeEpic) {
      notifications.push({
        code: 'orphan-ticket',
        line: index,
        message: `Ticket on line ${index + 1} is not associated with an epic.`
      });
      return;
    }

    if (parsed.indent > ticketIndentation) {
      while (ticketStack.length && ticketStack[ticketStack.length - 1].indent >= parsed.indent) {
        ticketStack.pop();
      }
      if (!ticketStack.length) {
        notifications.push({
          code: 'missing-parent',
          line: index,
          message: `Nested ticket on line ${index + 1} has no preceding parent ticket at a lower indentation level.`
        });
      }
    }
    while (ticketStack.length && ticketStack[ticketStack.length - 1].indent >= parsed.indent) {
      ticketStack.pop();
    }
    ticketStack.push({ line: index, indent: parsed.indent, tag: parsed.tag });
  });

  return notifications;
}

function normalizeTicketDocument(text, options = {}) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = /\r?\n$/.test(text);
  const ticketIndentation = clampInteger(options.ticketIndentation, 4, 1);
  const descriptionIndentation = clampInteger(options.descriptionIndentation, 2, 0);
  const prefix = String(options.prefix || 'TKT').toUpperCase();
  const padding = clampInteger(options.padding, 4, 1, 10);
  const nextId = clampInteger(options.nextId, 1, 1, Number.MAX_SAFE_INTEGER);
  const numberingEnabled = options.numberingEnabled !== false;
  let lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const parsedLines = lines.map(line => parseStructuralLine(line, ticketIndentation));
  const firstEpic = parsedLines.findIndex(item => item && item.kind === 'epic');
  const firstOrphan = parsedLines.findIndex((item, index) =>
    item && item.kind === 'ticket' && (firstEpic === -1 || index < firstEpic)
  );
  let generatedEpic = false;

  if (firstOrphan !== -1) {
    lines.splice(
      firstOrphan,
      0,
      formatGeneratedEpic(prefix, nextId, padding, numberingEnabled)
    );
    generatedEpic = true;
  }

  const normalized = [];
  let activeEpic = false;
  let previousTicket = null;
  let ticketStack = [];
  let pendingEpicBoundary = false;

  for (const originalLine of lines) {
    const parsed = parseStructuralLine(originalLine, ticketIndentation);

    if (parsed && parsed.kind === 'epic') {
      while (normalized.length > 1 && !normalized[normalized.length - 1].trim() && !normalized[normalized.length - 2].trim()) {
        normalized.pop();
      }
      if (normalized.length && normalized[normalized.length - 1].trim()) normalized.push('');
      normalized.push(originalLine.trimStart());
      activeEpic = true;
      previousTicket = null;
      ticketStack = [];
      pendingEpicBoundary = true;
      continue;
    }

    if (pendingEpicBoundary && !originalLine.trim()) {
      continue;
    }

    if (pendingEpicBoundary && !(parsed && parsed.kind === 'description')) {
      normalized.push('');
      pendingEpicBoundary = false;
    }

    if (parsed && parsed.kind === 'ticket') {
      const content = originalLine.trimStart();
      let indent = Math.max(ticketIndentation, parsed.indent);
      indent = Math.ceil(indent / ticketIndentation) * ticketIndentation;

      if (parsed.hasSubMarker && previousTicket) {
        const declaredIndent = indent;
        const parent = [...ticketStack].reverse().find(item => item.indent <= declaredIndent)
          || previousTicket;
        indent = parent.indent + ticketIndentation;
      }
      if (!activeEpic) indent = ticketIndentation;

      normalized.push(`${' '.repeat(indent)}${content}`);
      previousTicket = { indent, tag: parsed.tag };
      while (ticketStack.length && ticketStack[ticketStack.length - 1].indent >= indent) {
        ticketStack.pop();
      }
      ticketStack.push(previousTicket);
      continue;
    }

    if (parsed && parsed.kind === 'description') {
      const ownerIndent = previousTicket ? previousTicket.indent : 0;
      normalized.push(`${' '.repeat(ownerIndent + descriptionIndentation)}${originalLine.trimStart()}`);
      continue;
    }

    if (parsed && parsed.kind === 'link') {
      const ownerIndent = previousTicket ? previousTicket.indent : 0;
      const indent = Math.max(ticketIndentation, ownerIndent + ticketIndentation);
      normalized.push(`${' '.repeat(indent)}${originalLine.trimStart()}`);
      continue;
    }

    normalized.push(originalLine);
  }

  if (pendingEpicBoundary && normalized.length && normalized[normalized.length - 1].trim()) {
    normalized.push('');
  }

  while (normalized.length > 1 && !normalized[normalized.length - 1].trim() && !normalized[normalized.length - 2].trim()) {
    normalized.pop();
  }

  let result = normalized.join(newline);
  if (hadFinalNewline) result += newline;
  return {
    text: result,
    changed: result !== text,
    generatedEpic,
    notifications: findHierarchyNotifications(result, { ticketIndentation })
  };
}

function ensureNotificationMarker(text, hasStructuralNotifications) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const markerIndex = lines.findIndex(line => /^\[\*?NOTIFICATION\]/i.test(line.trim()));
  const activeAlready = markerIndex !== -1 && /^\[\*NOTIFICATION\]/i.test(lines[markerIndex].trim());
  const active = hasStructuralNotifications || activeAlready;
  const marker = active
    ? '[*NOTIFICATION] Hover here for active ticket notifications.'
    : '[NOTIFICATION] No active ticket notifications.';

  if (markerIndex !== -1) {
    lines[markerIndex] = marker;
  } else {
    const helpIndex = lines.findIndex(line => /^\[HELP\]/i.test(line.trim()));
    lines.splice(helpIndex === -1 ? 0 : helpIndex + 1, 0, marker);
  }

  let result = lines.join(newline);
  if (hadFinalNewline) result += newline;
  return { text: result, changed: result !== text, active };
}

function ensureInfoMarker(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const marker = '[INFO] Hover here for the current ticket summary.';
  const markerIndex = lines.findIndex(line => /^\[INFO\]/i.test(line.trim()));
  if (markerIndex !== -1) {
    lines[markerIndex] = marker;
  } else {
    const notificationIndex = lines.findIndex(line => /^\[\*?NOTIFICATION\]/i.test(line.trim()));
    const helpIndex = lines.findIndex(line => /^\[HELP\]/i.test(line.trim()));
    const insertAt = notificationIndex !== -1 ? notificationIndex + 1 : helpIndex !== -1 ? helpIndex + 1 : 0;
    lines.splice(insertAt, 0, marker);
  }

  let result = lines.join(newline);
  if (hadFinalNewline) result += newline;
  return { text: result, changed: result !== text };
}

module.exports = {
  clampInteger,
  formatTrackerTitle,
  ensureTrackerHeader,
  getNotificationSidecarPath,
  leadingWidth,
  parseStructuralLine,
  buildTicketSummary,
  findHierarchyNotifications,
  normalizeTicketDocument,
  ensureNotificationMarker,
  ensureInfoMarker
};
