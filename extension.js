const vscode = require('vscode');
const {
  clampInteger,
  formatTrackerTitle,
  ensureTrackerHeader,
  getNotificationSidecarPath,
  buildTicketSummary,
  findHierarchyNotifications,
  normalizeTicketDocument,
} = require('./ticketFlow');

function createProjectPrefix(projectName) {
  const expandedName = String(projectName || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const ignoredWords = new Set(['a', 'an', 'and', 'app', 'application', 'for', 'of', 'project', 'system', 'the', 'to']);
  const words = expandedName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter(word => !ignoredWords.has(word.toLowerCase()));

  if (words.length > 1) {
    return words.slice(0, 5).map(word => word[0]).join('').toUpperCase();
  }

  const singleWord = words[0] || expandedName.replace(/[^A-Za-z0-9]/g, '');
  return singleWord.slice(0, singleWord.length <= 5 ? 5 : 3).toUpperCase();
}

function inferProjectName(document) {
  const lines = document.getText().split('\n').slice(0, 20);
  for (const line of lines) {
    const projectMatch = line.match(/^\s*\[?PROJECT(?:\s+NAME|\s+IDEA)?\s*:\s*([^\]]+)\]?\s*$/i);
    if (projectMatch) return projectMatch[1].trim();

    const trackerHeading = line.match(/^\s*([A-Z][A-Z0-9 _-]+?)\s*-\s*(?:BUG\s*&\s*SUGGESTION|TICKET)\s+TRACKER\s*$/);
    if (trackerHeading && !/^TICKETS?$/i.test(trackerHeading[1].trim())) {
      return trackerHeading[1].trim();
    }
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) {
    if (workspaceFolder.name) return workspaceFolder.name;
  }

  const pathParts = document.uri.path.split('/').filter(Boolean);
  const fileName = pathParts.pop() || 'tickets';
  return pathParts.pop() || fileName.replace(/\.(tickets|tkt)$/i, '');
}

function getProjectPrefix(document) {
  const text = document.getText();
  const lines = text.split('\n').slice(0, 20);
  for (const line of lines) {
    const match = line.match(/^\s*(?:\/\/|#|\/\*|)\s*\[?PREFIX\s*:\s*([A-Za-z0-9_-]+)\]?/i);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
  const configuredPrefix = String(config.get('projectPrefix') || '').trim();
  if (configuredPrefix) return configuredPrefix.toUpperCase();

  const existingId = text.match(/^\s*[$@#*!^~]-\s*(?:\[(?:BUG|B|FT|F|ENH|E|EPIC|EP)\])?\[([A-Za-z][A-Za-z0-9_-]*)-\d+\]/im);
  if (existingId) return existingId[1].toUpperCase();

  return createProjectPrefix(inferProjectName(document));
}

function getNextIdNumber(document, prefix) {
  const registry = collectTicketIds(document.getText());
  const ids = registry.get(prefix.toUpperCase()) || [];
  let maxNum = 0;
  for (const id of ids) {
    const num = parseInt(id.slice(id.lastIndexOf('-') + 1), 10);
    if (!isNaN(num) && num > maxNum) {
      maxNum = num;
    }
  }
  return maxNum + 1;
}

function formatId(prefix, number, padding) {
  const numStr = number.toString();
  const padded = numStr.padStart(padding, '0');
  return `[${prefix}-${padded}]`;
}

function shouldRestoreLinkPlaceholder(lineText, lineNumber, changedLines) {
  if (!/^\s*\[LINK\]/i.test(lineText)) return false;
  const linkEnd = lineText.toUpperCase().indexOf('[LINK]') + 6;
  const linkPayload = lineText.substring(linkEnd);
  return !linkPayload.trim() && !changedLines.has(lineNumber);
}

function selectionsContainLine(selections, lineNumber) {
  return selections.some(selection =>
    selection.start.line <= lineNumber && selection.end.line >= lineNumber
  );
}

function collectTicketIds(text, registry = new Map()) {
  const declaredPrefix = text.match(/^\s*(?:\/\/|#|\/\*|)\s*\[?PREFIX\s*:\s*([A-Za-z0-9_-]+)\]?/im);
  if (declaredPrefix && !registry.has(declaredPrefix[1].toUpperCase())) {
    registry.set(declaredPrefix[1].toUpperCase(), new Set());
  }
  for (const line of text.split('\n')) {
    const isTicket = /^\s*[$@#*!^~]-\s*(?:--+\s*)?\[(?:BUG|B|FT|F|ENH|E|EPIC|EP|SUB|TEST)\]/i.test(line)
      || /^\s*--+\s*\[(?:BUG|B|FT|F|ENH|E|SUB|TEST)\]/i.test(line);
    if (!isTicket) continue;
    const match = line.match(/\[([A-Za-z][A-Za-z0-9_-]*)-(\d+)\]/);
    if (!match) continue;
    const prefix = match[1].toUpperCase();
    if (!registry.has(prefix)) registry.set(prefix, new Set());
    registry.get(prefix).add(`${prefix}-${match[2]}`);
  }
  return registry;
}

function activate(context) {
  let customRulesDecorations = [];
  let isEditing = false;
  let activeLinkEdit = null;
  let structureTimer;
  const notificationSignatures = new Map();
  const notificationState = new Map();

  // Default Decoration Types (we will recreate them when config changes)
  let decCompleted, decWorking, decReady, decPlanned, decCancelled, decFailed, decEpic;
  let decComment, decTagBug, decTagFeature, decTagEnh, decTagEpic, decTagDesc, decTagSub, decTagTest, decTagHelp, decInfo, decNotification, decNotificationActive, decDescription;
  let decLinkVerified, decLinkMissingNumber, decLinkUnknown, decLinkNil, decInvalidSub;
  let workspaceTicketRegistry = new Map();
  let registryRefreshTimer;

  async function refreshWorkspaceTicketRegistry() {
    const registry = new Map();
    const files = await vscode.workspace.findFiles('**/*.{tickets,tkt}', '**/{node_modules,.git}/**');
    await Promise.all(files.map(async uri => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        collectTicketIds(Buffer.from(bytes).toString('utf8'), registry);
      } catch (_) { /* inaccessible ticket file */ }
    }));
    vscode.workspace.textDocuments.filter(isTargetFile).forEach(doc => collectTicketIds(doc.getText(), registry));
    workspaceTicketRegistry = registry;
    if (activeEditor) updateDecorations(activeEditor);
  }

  function scheduleRegistryRefresh() {
    if (registryRefreshTimer) clearTimeout(registryRefreshTimer);
    registryRefreshTimer = setTimeout(() => refreshWorkspaceTicketRegistry(), 250);
  }

  function getFlowOptions(document) {
    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const ticketIndentation = clampInteger(config.get('ticketIndentation'), 4, 1);
    return {
      ticketIndentation,
      descriptionIndentation: clampInteger(config.get('descriptionIndentation'), 2, 0),
      numberingEnabled: config.get('enableTicketNumbering') !== false,
      prefix: getProjectPrefix(document),
      projectName: inferProjectName(document),
      padding: config.get('idPadding') || 4,
      nextId: getNextWorkspaceIdNumber(document, getProjectPrefix(document))
    };
  }

  function getNotificationUri(document) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || document.uri.scheme !== 'file') return null;
    return document.uri.with({
      path: getNotificationSidecarPath(document.uri.path, folder.uri.path)
    });
  }

  async function ensureNotificationInfrastructure(document, notifications) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return;

    const notificationUri = getNotificationUri(document);
    if (!notificationUri) return;
    const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
    try {
      const notificationDirectoryPath = notificationUri.path.slice(0, notificationUri.path.lastIndexOf('/'));
      await vscode.workspace.fs.createDirectory(notificationUri.with({ path: notificationDirectoryPath }));

      let gitignore = '';
      try {
        gitignore = Buffer.from(await vscode.workspace.fs.readFile(gitignoreUri)).toString('utf8');
      } catch (_) { /* create it below */ }
      const notificationIgnoreRules = ['.tickets/notifications/', '*.tkt.notification', '*.tickets.notification'];
      const missingIgnoreRules = notificationIgnoreRules.filter(rule =>
        !gitignore.split(/\r?\n/).some(line => line.trim() === rule)
      );
      if (missingIgnoreRules.length) {
        const separator = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
        await vscode.workspace.fs.writeFile(
          gitignoreUri,
          Buffer.from(`${gitignore}${separator}${missingIgnoreRules.join('\n')}\n`, 'utf8')
        );
      }

      const relativeName = vscode.workspace.asRelativePath(document.uri, false);
      let record = `# Tickets notification record\n# Associated ticket file: ${relativeName}\n# Managed by Tickets - vibe coding. This file is intentionally gitignored.\n`;
      let recordExists = false;
      try {
        record = Buffer.from(await vscode.workspace.fs.readFile(notificationUri)).toString('utf8');
        recordExists = true;
      } catch (_) {
        // Preserve any record created by v2.1.2, but leave the legacy file untouched.
        const legacyUri = document.uri.with({ path: `${document.uri.path}.notification` });
        try {
          record = Buffer.from(await vscode.workspace.fs.readFile(legacyUri)).toString('utf8');
        } catch (_) { /* create the new support-folder record below */ }
      }

      const documentKey = document.uri.toString();
      const signature = notifications.map(item => `${item.code}:${item.line}:${item.message}`).join('|');
      if (notificationSignatures.get(documentKey) === signature) {
        if (!recordExists) await vscode.workspace.fs.writeFile(notificationUri, Buffer.from(record, 'utf8'));
        return;
      }
      const previousSignature = notificationSignatures.get(documentKey);
      notificationSignatures.set(documentKey, signature);

      if (!notifications.length && previousSignature === undefined) {
        if (!recordExists) await vscode.workspace.fs.writeFile(notificationUri, Buffer.from(record, 'utf8'));
        return;
      }

      const timestamp = new Date().toISOString();
      const entry = notifications.length
        ? `\n[${timestamp}] [ACTIVE] ${relativeName}\n${notifications.map(item => `- ${item.message}`).join('\n')}\n`
        : `\n[${timestamp}] [RESOLVED] ${relativeName}\n- No structural ticket notifications remain.\n`;
      await vscode.workspace.fs.writeFile(notificationUri, Buffer.from(`${record.replace(/\s*$/, '')}\n${entry}`, 'utf8'));
    } catch (_) {
      // Notification persistence must never interrupt ticket editing.
    }
  }

  function applyStructureNormalization(editor) {
    if (!editor || isEditing || !isTargetFile(editor.document)) return;
    const document = editor.document;
    const options = getFlowOptions(document);
    const normalized = normalizeTicketDocument(document.getText(), options);
    const withHeader = ensureTrackerHeader(normalized.text, {
      prefix: options.prefix,
      projectName: options.projectName,
      hasStructuralNotifications: normalized.notifications.length > 0
    });
    const notifications = findHierarchyNotifications(withHeader.text, options);
    notificationState.set(document.uri.toString(), notifications);

    if (!withHeader.changed && !normalized.changed) {
      ensureNotificationInfrastructure(document, notifications);
      return;
    }

    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, withHeader.text);
    isEditing = true;
    vscode.workspace.applyEdit(edit).then(() => {
      isEditing = false;
      updateDecorations(editor);
      scheduleRegistryRefresh();
      ensureNotificationInfrastructure(document, notifications);
    }, () => {
      isEditing = false;
    });
  }

  function scheduleStructureNormalization(editor, delay = 350) {
    if (structureTimer) clearTimeout(structureTimer);
    structureTimer = setTimeout(() => {
      if (isEditing) {
        scheduleStructureNormalization(editor, 150);
        return;
      }
      applyStructureNormalization(editor);
    }, delay);
  }

  function getNextWorkspaceIdNumber(document, prefix) {
    let max = getNextIdNumber(document, prefix) - 1;
    const ids = workspaceTicketRegistry.get(prefix.toUpperCase()) || [];
    for (const id of ids) {
      const number = Number(id.slice(id.lastIndexOf('-') + 1));
      if (number > max) max = number;
    }
    return max + 1;
  }

  // Create Status Bar Item for toggling full line highlight
  let statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tickets-vibe-coding.toggleFullLineHighlight';
  context.subscriptions.push(statusBarItem);

  // Helper function to convert Hex color to RGBA with custom opacity
  function hexToRgbA(hex, alpha) {
    let c;
    if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)) {
      c = hex.substring(1).split('');
      if (c.length === 3) {
        c = [c[0], c[0], c[1], c[1], c[2], c[2]];
      }
      c = '0x' + c.join('');
      return `rgba(${[(c >> 16) & 255, (c >> 8) & 255, c & 255].join(',')},${alpha})`;
    }
    return hex; // fallback to user's text if not standard hex
  }

  function initDecorations() {
    // Dispose of any existing decorations
    if (decCompleted) decCompleted.dispose();
    if (decWorking) decWorking.dispose();
    if (decReady) decReady.dispose();
    if (decPlanned) decPlanned.dispose();
    if (decCancelled) decCancelled.dispose();
    if (decFailed) decFailed.dispose();
    if (decEpic) decEpic.dispose();
    if (decComment) decComment.dispose();
    if (decTagBug) decTagBug.dispose();
    if (decTagFeature) decTagFeature.dispose();
    if (decTagEnh) decTagEnh.dispose();
    if (decTagEpic) decTagEpic.dispose();
    if (decTagDesc) decTagDesc.dispose();
    if (decTagSub) decTagSub.dispose();
    if (decTagTest) decTagTest.dispose();
    if (decTagHelp) decTagHelp.dispose();
    if (decInfo) decInfo.dispose();
    if (decNotification) decNotification.dispose();
    if (decNotificationActive) decNotificationActive.dispose();
    if (decLinkVerified) decLinkVerified.dispose();
    if (decLinkMissingNumber) decLinkMissingNumber.dispose();
    if (decLinkUnknown) decLinkUnknown.dispose();
    if (decLinkNil) decLinkNil.dispose();
    if (decInvalidSub) decInvalidSub.dispose();
    if (decDescription) decDescription.dispose();

    customRulesDecorations.forEach(d => d.decorationType.dispose());
    customRulesDecorations = [];

    // Load active settings configurations
    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const colorCompleted = config.get('colors.completed') || '#10b981';
    const colorWorking = config.get('colors.working') || '#f59e0b';
    const colorReady = config.get('colors.ready') || '#06b6d4';
    const colorPlanned = config.get('colors.planned') || '#64748b';
    const colorCancelled = config.get('colors.cancelled') || '#475569';
    const colorFailed = config.get('colors.failed') || '#ef4444';
    const colorEpic = config.get('colors.epic') || '#8b5cf6';

    // Recreate default decoration structures
    decCompleted = vscode.window.createTextEditorDecorationType({ color: colorCompleted, fontWeight: 'bold' });
    decWorking = vscode.window.createTextEditorDecorationType({ color: colorWorking, fontWeight: 'bold' });
    decReady = vscode.window.createTextEditorDecorationType({ color: colorReady, fontWeight: 'bold' });
    decPlanned = vscode.window.createTextEditorDecorationType({ color: colorPlanned, fontStyle: 'italic' });
    decCancelled = vscode.window.createTextEditorDecorationType({ color: colorCancelled, textDecoration: 'line-through' });
    decFailed = vscode.window.createTextEditorDecorationType({
      color: colorFailed,
      fontWeight: 'bold',
      backgroundColor: 'rgba(239, 68, 68, 0.12)',
      borderRadius: '4px'
    });
    decEpic = vscode.window.createTextEditorDecorationType({ color: colorEpic, fontWeight: 'bold' });

    decComment = vscode.window.createTextEditorDecorationType({ color: '#64748b', fontStyle: 'italic' });

    decTagBug = vscode.window.createTextEditorDecorationType({
      color: '#ef4444',
      fontWeight: 'bold',
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      border: '1px solid rgba(239, 68, 68, 0.25)',
      borderRadius: '4px'
    });
    decTagFeature = vscode.window.createTextEditorDecorationType({
      color: '#8b5cf6',
      fontWeight: 'bold',
      backgroundColor: 'rgba(139, 92, 246, 0.1)',
      border: '1px solid rgba(139, 92, 246, 0.25)',
      borderRadius: '4px'
    });
    decTagEnh = vscode.window.createTextEditorDecorationType({
      color: '#0ea5e9',
      fontWeight: 'bold',
      backgroundColor: 'rgba(14, 165, 233, 0.1)',
      border: '1px solid rgba(14, 165, 233, 0.25)',
      borderRadius: '4px'
    });
    decTagEpic = vscode.window.createTextEditorDecorationType({
      color: '#8b5cf6',
      fontWeight: 'bold',
      backgroundColor: 'rgba(139, 92, 246, 0.1)',
      border: '1px solid rgba(139, 92, 246, 0.25)',
      borderRadius: '4px'
    });
    decTagDesc = vscode.window.createTextEditorDecorationType({
      color: '#0f766e',
      fontWeight: 'bold',
      backgroundColor: 'rgba(15, 118, 110, 0.1)',
      border: '1px solid rgba(15, 118, 110, 0.25)',
      borderRadius: '4px'
    });
    decTagSub = vscode.window.createTextEditorDecorationType({
      color: '#db2777', fontWeight: 'bold', backgroundColor: 'rgba(219, 39, 119, 0.12)',
      border: '1px solid rgba(219, 39, 119, 0.35)', borderRadius: '4px'
    });
    decTagTest = vscode.window.createTextEditorDecorationType({
      color: '#d97706', fontWeight: 'bold', backgroundColor: 'rgba(217, 119, 6, 0.12)',
      border: '1px solid rgba(217, 119, 6, 0.35)', borderRadius: '4px'
    });
    decTagHelp = vscode.window.createTextEditorDecorationType({
      color: '#0284c7', fontWeight: 'bold', backgroundColor: 'rgba(2, 132, 199, 0.10)',
      border: '1px solid rgba(2, 132, 199, 0.35)', borderRadius: '4px'
    });
    decInfo = vscode.window.createTextEditorDecorationType({
      color: '#0369a1', fontWeight: 'bold', backgroundColor: 'rgba(14, 165, 233, 0.12)',
      border: '1px solid rgba(14, 165, 233, 0.4)', borderRadius: '4px'
    });
    decNotification = vscode.window.createTextEditorDecorationType({
      color: '#64748b', fontWeight: 'bold', backgroundColor: 'rgba(100, 116, 139, 0.10)',
      border: '1px solid rgba(100, 116, 139, 0.35)', borderRadius: '4px'
    });
    decNotificationActive = vscode.window.createTextEditorDecorationType({
      color: '#f59e0b', fontWeight: 'bold', backgroundColor: 'rgba(245, 158, 11, 0.13)',
      border: '1px solid rgba(245, 158, 11, 0.45)', borderRadius: '4px'
    });
    decLinkVerified = vscode.window.createTextEditorDecorationType({ color: '#16a34a', fontWeight: 'bold' });
    decLinkMissingNumber = vscode.window.createTextEditorDecorationType({ color: '#f59e0b', fontWeight: 'bold' });
    decLinkUnknown = vscode.window.createTextEditorDecorationType({ color: '#ef4444', fontWeight: 'bold' });
    decLinkNil = vscode.window.createTextEditorDecorationType({ color: '#64748b', fontStyle: 'italic' });
    decInvalidSub = vscode.window.createTextEditorDecorationType({
      color: '#ef4444', fontWeight: 'bold', border: '1px solid #ef4444', borderRadius: '4px'
    });
    decDescription = vscode.window.createTextEditorDecorationType({
      color: '#475569',
      fontStyle: 'italic'
    });

    // Build custom user rules configurations
    const customRules = config.get('customRules') || [];
    customRules.forEach((rule) => {
      const style = {};
      if (rule.color) style.color = rule.color;
      if (rule.bold !== false) style.fontWeight = 'bold';
      if (rule.italic) style.fontStyle = 'italic';
      if (rule.strikethrough) style.textDecoration = 'line-through';

      // Badge treatment if it is a tag or has custom background/borders
      if (rule.tag) {
        style.backgroundColor = rule.backgroundColor || (rule.color ? hexToRgbA(rule.color, 0.1) : undefined);
        style.border = rule.border || (rule.color ? `1px solid ${hexToRgbA(rule.color, 0.25)}` : undefined);
      } else {
        if (rule.backgroundColor) style.backgroundColor = rule.backgroundColor;
        if (rule.border) style.border = rule.border;
      }
      style.borderRadius = '4px';

      // Precompile Regex matcher to avoid recreating it on every line check
      let preparedRegex = null;
      if (rule.tag) {
        const tagEscaped = rule.tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        preparedRegex = new RegExp(`\\[${tagEscaped}\\]`, 'gi'); // Case-insensitive matching!
      } else if (rule.regex) {
        try {
          preparedRegex = new RegExp(rule.regex, 'gi');
        } catch (e) {
          // invalid regex
        }
      }

      const decType = vscode.window.createTextEditorDecorationType(style);
      customRulesDecorations.push({
        rule: rule,
        decorationType: decType,
        regex: preparedRegex
      });
    });
  }

  // Helper to check target file extension
  function isTargetFile(document) {
    if (!document || !document.fileName) return false;
    const fileName = document.fileName.toLowerCase();
    return (
      fileName.endsWith('.tickets') ||
      fileName.endsWith('.tkt')
    );
  }

  function updateStatusBar() {
    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const isFull = config.get('highlightFullLine') || false;
    statusBarItem.text = isFull ? '$(color-mode) Tickets: Full Line' : '$(color-mode) Tickets: Prefix Only';
    statusBarItem.tooltip = 'Click to toggle between Full Line or Prefix Only highlighting';
    statusBarItem.show();
  }

  function updateStatusBarVisibility(editor) {
    if (editor && isTargetFile(editor.document)) {
      updateStatusBar();
    } else {
      statusBarItem.hide();
    }
  }

  function updateDecorations(editor) {
    if (!editor) return;
    const document = editor.document;
    if (!isTargetFile(document)) return;

    const text = document.getText();
    const lines = text.split('\n');

    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const highlightFullLine = config.get('highlightFullLine') || false;

    const listCompleted = [];
    const listWorking = [];
    const listReady = [];
    const listPlanned = [];
    const listCancelled = [];
    const listFailed = [];
    const listEpic = [];
    const listComments = [];
    const listTagsBug = [];
    const listTagsFeature = [];
    const listTagsEnh = [];
    const listTagsEpic = [];
    const listTagsDesc = [];
    const listTagsSub = [];
    const listTagsTest = [];
    const listTagsHelp = [];
    const listInfo = [];
    const listNotifications = [];
    const listActiveNotifications = [];
    const listLinksVerified = [];
    const listLinksMissingNumber = [];
    const listLinksUnknown = [];
    const listLinksNil = [];
    const listInvalidSubs = [];
    const listDescriptions = [];

    // Custom rules matches maps
    const customRangesLists = customRulesDecorations.map(() => []);

    // Multi-line block comments scanner
    const blockCommentRegex = /\/\*[\s\S]*?\*\//g;
    let blockMatch;
    const blockCommentRanges = [];

    while ((blockMatch = blockCommentRegex.exec(text)) !== null) {
      const startPos = document.positionAt(blockMatch.index);
      const endPos = document.positionAt(blockMatch.index + blockMatch[0].length);
      const range = new vscode.Range(startPos, endPos);
      listComments.push(range);
      blockCommentRanges.push(range);
    }

    function isInsideBlockComment(lineIndex, charIndex) {
      const pos = new vscode.Position(lineIndex, charIndex);
      return blockCommentRanges.some(range => range.contains(pos));
    }

    let activeStack = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comment blocks
      if (isInsideBlockComment(i, 0) && isInsideBlockComment(i, line.length > 0 ? line.length - 1 : 0)) {
        continue;
      }
      if (trimmed.startsWith('===') || trimmed.startsWith('---')) {
        continue;
      }

      const notificationMatch = line.match(/^\s*\[(\*?)NOTIFICATION\]/i);
      if (notificationMatch) {
        const range = new vscode.Range(
          new vscode.Position(i, notificationMatch.index),
          new vscode.Position(i, notificationMatch.index + notificationMatch[0].length)
        );
        if (notificationMatch[1]) listActiveNotifications.push(range);
        else listNotifications.push(range);
      }

      const infoMatch = line.match(/^\s*\[INFO\]/i);
      if (infoMatch) {
        const start = line.toUpperCase().indexOf('[INFO]');
        listInfo.push(new vscode.Range(
          new vscode.Position(i, start),
          new vscode.Position(i, start + 6)
        ));
      }

      // Check if it is a Description line
      const descMatch = line.match(/^(\s*)\[(DESC|DESCRIPTION)\]/i);
      if (descMatch) {
        const indentStr = descMatch[1];
        const tagText = descMatch[2];
        const tagStart = indentStr.length;
        const tagLength = tagText.length + 2; // [ + tagText + ]

        listTagsDesc.push(new vscode.Range(
          new vscode.Position(i, tagStart),
          new vscode.Position(i, tagStart + tagLength)
        ));

        // Highlight rest of the description line
        const descTextStart = tagStart + tagLength;
        if (line.length > descTextStart) {
          listDescriptions.push(new vscode.Range(
            new vscode.Position(i, descTextStart),
            new vscode.Position(i, line.length)
          ));
        }
        continue; // Skip further ticket/bullet checks for description lines!
      }

      // Check inline comments
      const commentIdx = line.indexOf('//');
      if (commentIdx !== -1 && !isInsideBlockComment(i, commentIdx)) {
        listComments.push(new vscode.Range(
          new vscode.Position(i, commentIdx),
          new vscode.Position(i, line.length)
        ));
      }

      const indent = line.match(/^\s*/)[0].length;
      let status = null;
      let dashes = 0;

      const codePart = commentIdx !== -1 ? line.substring(0, commentIdx) : line;
      const statusMatch = codePart.match(/^\s*([$@#*!^~])-\s*/);
      const bulletMatch = codePart.match(/^\s*(-+)(?:\s+|$)/);

      if (statusMatch) {
        status = statusMatch[1];
      } else if (bulletMatch) {
        dashes = bulletMatch[1].length;
      }

      // Pop items from stack that are not ancestors of the current line
      while (activeStack.length > 0) {
        const top = activeStack[activeStack.length - 1];
        
        if (indent < top.indent) {
          activeStack.pop();
        } else if (indent === top.indent) {
          if (status) {
            activeStack.pop();
          } else if (dashes > 0 && top.dashes > 0 && dashes <= top.dashes) {
            activeStack.pop();
          } else if (dashes === 0 && top.dashes > 0) {
            activeStack.pop();
          } else {
            break;
          }
        } else {
          break;
        }
      }

      // Determine inherited status
      let inheritedStatus = null;
      if (status) {
        inheritedStatus = status;
        activeStack.push({ indent, dashes, status });
      } else if (activeStack.length > 0) {
        inheritedStatus = activeStack[activeStack.length - 1].status;
        if (dashes > 0) {
          activeStack.push({ indent, dashes, status: inheritedStatus });
        }
      }

      if (inheritedStatus) {
        const endLimit = commentIdx !== -1 ? commentIdx : line.length;
        
        let rangeStart = 0;
        let rangeEnd = 0;
        
        if (statusMatch) {
          const matchStart = line.indexOf(statusMatch[1] + '-');
          rangeStart = matchStart;
          rangeEnd = highlightFullLine ? endLimit : (matchStart + 2);
        } else if (bulletMatch) {
          const matchStart = line.indexOf(bulletMatch[1]);
          rangeStart = matchStart;
          rangeEnd = highlightFullLine ? endLimit : (matchStart + bulletMatch[1].length);
        } else {
          if (highlightFullLine) {
            rangeStart = indent;
            rangeEnd = endLimit;
          }
        }
        
        if (rangeEnd > rangeStart) {
          const targetList = inheritedStatus === '$' ? listCompleted
            : inheritedStatus === '@' ? listWorking : inheritedStatus === '#' ? listReady
            : inheritedStatus === '*' ? listPlanned : inheritedStatus === '!' ? listCancelled
            : inheritedStatus === '^' ? listFailed : listEpic;
          // Split full-line status decoration around tags so every tag retains its own colour.
          const excluded = [];
          if (highlightFullLine) {
            const tagRegex = /^\s*\[LINK\]/i.test(line)
              ? /\[(?:(?:LINK)|(?:[A-Za-z][A-Za-z0-9_-]*-\d+))\]/gi
              : /\[(?:BUG|B|FT|F|ENH|ENHANCEMENT|E|EPIC|EP|SUB|TEST|LINK)\]/gi;
            let tag;
            while ((tag = tagRegex.exec(line)) !== null) excluded.push([tag.index, tag.index + tag[0].length]);
          }
          let cursor = rangeStart;
          excluded.filter(([start, end]) => end > rangeStart && start < rangeEnd).forEach(([start, end]) => {
            if (start > cursor) targetList.push(new vscode.Range(new vscode.Position(i, cursor), new vscode.Position(i, start)));
            cursor = Math.max(cursor, end);
          });
          if (cursor < rangeEnd) targetList.push(new vscode.Range(new vscode.Position(i, cursor), new vscode.Position(i, rangeEnd)));
        }
      }

      // Default Tags (Case-insensitive & explicitly ordered alternatives)
      const tagBugRegex = /\[(BUG|B|bug|b)\]/gi;
      const tagFeatureRegex = /\[(FT|F|ft|f)\]/gi;
      const tagEnhRegex = /\[(ENH|ENHANCEMENT|Enh|E|enh|e)\]/gi;
      const tagEpicRegex = /\[(EPIC|EP|epic|ep)\]/gi;
      const tagSubRegex = /\[SUB\]/gi;
      const tagTestRegex = /\[TEST\]/gi;
      const tagHelpRegex = /\[HELP\]/gi;
      let match;

      while ((match = tagBugRegex.exec(line)) !== null) {
        if (!isInsideBlockComment(i, match.index) && (commentIdx === -1 || match.index < commentIdx)) {
          listTagsBug.push(new vscode.Range(new vscode.Position(i, match.index), new vscode.Position(i, match.index + match[0].length)));
        }
      }
      while ((match = tagFeatureRegex.exec(line)) !== null) {
        if (!isInsideBlockComment(i, match.index) && (commentIdx === -1 || match.index < commentIdx)) {
          listTagsFeature.push(new vscode.Range(new vscode.Position(i, match.index), new vscode.Position(i, match.index + match[0].length)));
        }
      }
      while ((match = tagEnhRegex.exec(line)) !== null) {
        if (!isInsideBlockComment(i, match.index) && (commentIdx === -1 || match.index < commentIdx)) {
          listTagsEnh.push(new vscode.Range(new vscode.Position(i, match.index), new vscode.Position(i, match.index + match[0].length)));
        }
      }
      while ((match = tagEpicRegex.exec(line)) !== null) {
        if (!isInsideBlockComment(i, match.index) && (commentIdx === -1 || match.index < commentIdx)) {
          listTagsEpic.push(new vscode.Range(new vscode.Position(i, match.index), new vscode.Position(i, match.index + match[0].length)));
        }
      }
      while ((match = tagSubRegex.exec(line)) !== null) {
        if (commentIdx === -1 || match.index < commentIdx) {
          const range = new vscode.Range(new vscode.Position(i, match.index), new vscode.Position(i, match.index + match[0].length));
          listTagsSub.push(range);
          const subIndent = line.match(/^\s*/)[0].length;
          const configIndent = clampInteger(config.get('ticketIndentation'), 4, 1);
          const hasSubSyntax = /^\s*(?:[$@#*!^~]-\s*)?--+\s*\[SUB\]/i.test(line) || subIndent >= configIndent * 2;
          let parent = null;
          for (let p = i - 1; p >= 0; p--) {
            const parentLine = lines[p];
            if (!parentLine.trim()) continue;
            const parentIndent = parentLine.match(/^\s*/)[0].length;
            if (parentIndent < subIndent) { parent = parentLine; break; }
          }
          const validParent = parent && /\[(?:FT|F|BUG|B|ENH|E)\]/i.test(parent) && !/\[SUB\]/i.test(parent);
          if (!hasSubSyntax || !validParent) listInvalidSubs.push(range);
        }
      }
      while ((match = tagTestRegex.exec(line)) !== null) {
        if (commentIdx === -1 || match.index < commentIdx) {
          listTagsTest.push(new vscode.Range(new vscode.Position(i, match.index), new vscode.Position(i, match.index + match[0].length)));
        }
      }
      while ((match = tagHelpRegex.exec(line)) !== null) {
        listTagsHelp.push(new vscode.Range(new vscode.Position(i, match.index), new vscode.Position(i, match.index + match[0].length)));
      }

      const linkMatch = line.match(/^\s*\[LINK\]/i);
      if (linkMatch) {
        const start = line.indexOf('[LINK]');
        const tagRange = new vscode.Range(new vscode.Position(i, start), new vscode.Position(i, start + 6));
        const referenceRegex = /\[([A-Za-z][A-Za-z0-9_-]*)-(\d+)\]/g;
        let reference;
        let worstSeverity = 0; // 0 green, 1 orange, 2 red
        let referenceCount = 0;
        while ((reference = referenceRegex.exec(line)) !== null) {
          referenceCount++;
          const linkPrefix = reference[1].toUpperCase();
          const key = `${linkPrefix}-${reference[2]}`;
          const range = new vscode.Range(new vscode.Position(i, reference.index), new vscode.Position(i, reference.index + reference[0].length));
          const knownIds = workspaceTicketRegistry.get(linkPrefix);
          if (knownIds && knownIds.has(key)) listLinksVerified.push(range);
          else {
            listLinksUnknown.push(range);
            worstSeverity = 2;
          }
        }
        const hasNil = /\{nil\}/i.test(line);
        if (hasNil || referenceCount === 0) worstSeverity = Math.max(worstSeverity, 1);
        if (hasNil) {
          const nilStart = line.search(/\{nil\}/i);
          listLinksMissingNumber.push(new vscode.Range(new vscode.Position(i, nilStart), new vscode.Position(i, nilStart + 5)));
        }
        if (worstSeverity === 2) listLinksUnknown.push(tagRange);
        else if (worstSeverity === 1) listLinksMissingNumber.push(tagRange);
        else listLinksVerified.push(tagRange);
      }

      // Apply custom rules
      customRulesDecorations.forEach((item, rIdx) => {
        const rule = item.rule;
        // Check prefix matching
        if (rule.prefix && trimmed.startsWith(rule.prefix)) {
          if (!isInsideBlockComment(i, line.indexOf(rule.prefix))) {
            const start = line.indexOf(rule.prefix);
            const end = (rule.strikethrough) ? (commentIdx !== -1 ? commentIdx : line.length) : (start + rule.prefix.length);
            customRangesLists[rIdx].push(new vscode.Range(new vscode.Position(i, start), new vscode.Position(i, end)));
          }
        }
        // Check tag and regex matches (via precompiled RegExp)
        if (item.regex) {
          let regMatch;
          item.regex.lastIndex = 0; // Reset index for global regex scan
          while ((regMatch = item.regex.exec(line)) !== null) {
            if (!isInsideBlockComment(i, regMatch.index) && (commentIdx === -1 || regMatch.index < commentIdx)) {
              customRangesLists[rIdx].push(new vscode.Range(
                new vscode.Position(i, regMatch.index),
                new vscode.Position(i, regMatch.index + regMatch[0].length)
              ));
            }
          }
        }
      });
    }

    editor.setDecorations(decCompleted, listCompleted);
    editor.setDecorations(decWorking, listWorking);
    editor.setDecorations(decReady, listReady);
    editor.setDecorations(decPlanned, listPlanned);
    editor.setDecorations(decCancelled, listCancelled);
    editor.setDecorations(decFailed, listFailed);
    editor.setDecorations(decEpic, listEpic);
    editor.setDecorations(decComment, listComments);
    editor.setDecorations(decTagBug, listTagsBug);
    editor.setDecorations(decTagFeature, listTagsFeature);
    editor.setDecorations(decTagEnh, listTagsEnh);
    editor.setDecorations(decTagEpic, listTagsEpic);
    editor.setDecorations(decTagDesc, listTagsDesc);
    editor.setDecorations(decTagSub, listTagsSub);
    editor.setDecorations(decTagTest, listTagsTest);
    editor.setDecorations(decTagHelp, listTagsHelp);
    editor.setDecorations(decInfo, listInfo);
    editor.setDecorations(decNotification, listNotifications);
    editor.setDecorations(decNotificationActive, listActiveNotifications);
    editor.setDecorations(decLinkVerified, listLinksVerified);
    editor.setDecorations(decLinkMissingNumber, listLinksMissingNumber);
    editor.setDecorations(decLinkUnknown, listLinksUnknown);
    editor.setDecorations(decLinkNil, listLinksNil);
    editor.setDecorations(decInvalidSub, listInvalidSubs);
    editor.setDecorations(decDescription, listDescriptions);

    // Set custom rules decorations
    customRulesDecorations.forEach((item, rIdx) => {
      editor.setDecorations(item.decorationType, customRangesLists[rIdx]);
    });
  }

  // Auto-uppercase tags and auto-generate ticket IDs logic
  function applyAutoEdits(editor, event) {
    if (isEditing) return;
    const document = editor.document;
    if (!isTargetFile(document)) return;

    // Find all unique lines affected by content changes
    const linesToUpdate = new Set();
    event.contentChanges.forEach(change => {
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      for (let l = startLine; l <= endLine + (change.text.split('\n').length - 1); l++) {
        if (l < document.lineCount) {
          linesToUpdate.add(l);
        }
      }
    });

    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const numberingEnabled = config.get('enableTicketNumbering') !== false;
    const autoGenerate = numberingEnabled && config.get('autoGenerateIds') !== false;
    const prefix = getProjectPrefix(document);
    const padding = config.get('idPadding') || 4;

    const workspaceEdit = new vscode.WorkspaceEdit();
    let hasChanges = false;
    let nextId = null;

    function getNextId() {
      if (nextId === null) {
        nextId = getNextWorkspaceIdNumber(document, prefix);
      } else {
        nextId++;
      }
      return nextId;
    }

    linesToUpdate.forEach(lineIdx => {
      const line = document.lineAt(lineIdx);
      let text = line.text;
      let lineChanged = false;

      // 1. Case normalization
      const commentIdx = text.indexOf('//');
      const codePart = commentIdx !== -1 ? text.substring(0, commentIdx) : text;

      let replacedCode = codePart.replace(/\[(b|bug|ft|f|e|enh|ep|epic)\]/gi, (match, tag) => {
        const upper = tag.toUpperCase();
        let normalized = upper;
        if (normalized === 'F') normalized = 'FT';
        if (normalized === 'EP') normalized = 'EPIC';
        
        const result = `[${normalized}]`;
        if (result !== match) {
          lineChanged = true;
        }
        return result;
      });

      replacedCode = replacedCode.replace(/\[(desc|description)\]/gi, (match, tag) => {
        const result = `[DESC]`;
        if (result !== match) {
          lineChanged = true;
        }
        return result;
      });
      replacedCode = replacedCode.replace(/\[(sub|test|link)\]/gi, (match, tag) => {
        const result = `[${tag.toUpperCase()}]`;
        if (result !== match) lineChanged = true;
        return result;
      });
      replacedCode = replacedCode.replace(/\[(\*?notification)\]/gi, (match, tag) => {
        const result = `[${tag.toUpperCase()}]`;
        if (result !== match) lineChanged = true;
        return result;
      });
      replacedCode = replacedCode.replace(/\[info\]/gi, match => {
        const result = '[INFO]';
        if (result !== match) lineChanged = true;
        return result;
      });

      let workingText = commentIdx !== -1 ? replacedCode + text.substring(commentIdx) : replacedCode;

      // 2. Auto-generate ID
      if (autoGenerate) {
        const trimmed = workingText.trim();
        if (!trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
          const nestedMatch = workingText.match(/^(\s*(?:[$@#*!^~]-\s*)?--+\s*)\[(BUG|B|FT|F|ENH|E|SUB|TEST)\]/i);
          const ticketMatch = nestedMatch || workingText.match(/^(\s*[$@#*!^~]-\s*)(?:\[(BUG|B|FT|F|ENH|E|EPIC|EP|SUB|TEST)\])?/i);
          if (ticketMatch) {
            const idRegex = /\[[A-Za-z][A-Za-z0-9_-]*-\d+\]/i;

            if (!idRegex.test(workingText)) {
              const prefixPart = ticketMatch[1];
              const tagPart = ticketMatch[2];

              let shouldInsert = false;
              let insertIndex = 0;
              let afterText = '';

              if (tagPart) {
                const tagIndex = workingText.toLowerCase().indexOf(`[${tagPart.toLowerCase()}]`);
                if (tagIndex !== -1) {
                  insertIndex = tagIndex + tagPart.length + 2;
                  afterText = workingText.substring(insertIndex);
                  if (afterText.length > 0) {
                    shouldInsert = true;
                  }
                }
              } else {
                insertIndex = prefixPart.length;
                afterText = workingText.substring(insertIndex);
                if (afterText.trim().length > 0) {
                  shouldInsert = true;
                }
              }

              if (shouldInsert) {
                const idNum = getNextId();
                const idStr = formatId(prefix, idNum, padding);
                const prefixAndTag = workingText.substring(0, insertIndex);
                const separator = (afterText.startsWith(' ') || afterText.startsWith('\t')) ? '' : ' ';
                workingText = `${prefixAndTag}${idStr}${separator}${afterText}`;
                lineChanged = true;
              }
            }
          }
        }
      }

      if (lineChanged) {
        workspaceEdit.replace(document.uri, line.range, workingText);
        hasChanges = true;
      }
    });

    // A test case always owns a child LINK line. Restore the placeholder if it is removed.
    for (let i = 0; i < document.lineCount; i++) {
      const testLine = document.lineAt(i).text;
      if (!/^\s*[$@#*!^~]-\s*(?:--+\s*)?\[TEST\]/i.test(testLine)) continue;
      const testIndent = testLine.match(/^\s*/)[0].length;
      let hasLink = false;
      for (let j = i + 1; j < document.lineCount; j++) {
        const childText = document.lineAt(j).text;
        if (!childText.trim()) continue;
        const childIndent = childText.match(/^\s*/)[0].length;
        if (childIndent <= testIndent) break;
        if (/^\s*\[LINK\]/i.test(childText)) {
          hasLink = true;
          const linkEnd = childText.toUpperCase().indexOf('[LINK]') + 6;
          // Do not repair the line during the user's character-by-character edit.
          // Once focus leaves an entirely empty LINK, the selection listener below
          // invokes this function with no changed lines and restores the placeholder.
          if (shouldRestoreLinkPlaceholder(childText, j, linesToUpdate)) {
            workspaceEdit.insert(document.uri, new vscode.Position(j, linkEnd), '{nil}');
            hasChanges = true;
          }
          break;
        }
      }
      if (!hasLink) {
        workspaceEdit.insert(document.uri, new vscode.Position(i + 1, 0), `${' '.repeat(testIndent + 2)}[LINK]{nil}\n`);
        hasChanges = true;
      }
    }

    // [HELP] is a protected discoverability marker and is restored if removed.
    if (!/^\[HELP\]/i.test(document.getText())) {
      workspaceEdit.insert(document.uri, new vscode.Position(0, 0), '[HELP] Hover here for ticket rules and conventions.\n');
      hasChanges = true;
    }

    if (hasChanges) {
      isEditing = true;
      vscode.workspace.applyEdit(workspaceEdit).then(() => {
        isEditing = false;
        scheduleRegistryRefresh();
        scheduleStructureNormalization(editor);
      }, () => {
        isEditing = false;
      });
    }
  }

  // Initialize and run
  initDecorations();

  let activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    updateDecorations(activeEditor);
    updateStatusBarVisibility(activeEditor);
    checkEmptyFile(activeEditor.document);
    applyAutoEdits(activeEditor, { contentChanges: [] });
    scheduleStructureNormalization(activeEditor);
  }
  refreshWorkspaceTicketRegistry();

  // Register the toggle Command
  let toggleCommand = vscode.commands.registerCommand('tickets-vibe-coding.toggleFullLineHighlight', () => {
    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const current = config.get('highlightFullLine') || false;
    config.update('highlightFullLine', !current, vscode.ConfigurationTarget.Global).then(() => {
      updateStatusBar();
      if (activeEditor) {
        updateDecorations(activeEditor);
      }
    });
  });
  context.subscriptions.push(toggleCommand);

  // Register the generateIds Command
  let generateIdsCommand = vscode.commands.registerCommand('tickets-vibe-coding.generateIds', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const document = editor.document;
    if (!isTargetFile(document)) return;

    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const prefix = getProjectPrefix(document);
    const padding = config.get('idPadding') || 4;

    const workspaceEdit = new vscode.WorkspaceEdit();
    let hasChanges = false;
    let nextId = getNextWorkspaceIdNumber(document, prefix);

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      let text = line.text;

      const trimmed = text.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('===') || trimmed.startsWith('---')) {
        continue;
      }

      const nestedMatch = text.match(/^(\s*(?:[$@#*!^~]-\s*)?--+\s*)\[(BUG|B|FT|F|ENH|E|SUB|TEST)\]/i);
      const ticketMatch = nestedMatch || text.match(/^(\s*[$@#*!^~]-\s*)(?:\[(BUG|B|FT|F|ENH|E|EPIC|EP|SUB|TEST)\])?/i);
      if (!ticketMatch) continue;

      const idRegex = /\[[A-Za-z][A-Za-z0-9_-]*-\d+\]/i;
      if (idRegex.test(text)) continue;

      const prefixPart = ticketMatch[1];
      const tagPart = ticketMatch[2];

      let insertIndex = 0;
      let afterText = '';

      if (tagPart) {
        const tagIndex = text.toLowerCase().indexOf(`[${tagPart.toLowerCase()}]`);
        if (tagIndex !== -1) {
          insertIndex = tagIndex + tagPart.length + 2;
          afterText = text.substring(insertIndex);
        }
      } else {
        insertIndex = prefixPart.length;
        afterText = text.substring(insertIndex);
      }

      const idStr = formatId(prefix, nextId++, padding);
      const prefixAndTag = text.substring(0, insertIndex);
      const separator = (afterText.startsWith(' ') || afterText.startsWith('\t')) ? '' : ' ';
      const newLineText = `${prefixAndTag}${idStr}${separator}${afterText}`;

      workspaceEdit.replace(document.uri, line.range, newLineText);
      hasChanges = true;
    }

    if (hasChanges) {
      isEditing = true;
      vscode.workspace.applyEdit(workspaceEdit).then(() => {
        isEditing = false;
        vscode.window.showInformationMessage('Successfully generated ticket IDs!');
      }, () => {
        isEditing = false;
      });
    } else {
      vscode.window.showInformationMessage('All tickets already have IDs.');
    }
  });
  context.subscriptions.push(generateIdsCommand);

  // Register the initializeTemplate Command
  let initializeTemplateCommand = vscode.commands.registerCommand('tickets-vibe-coding.initializeTemplate', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const document = editor.document;
    if (!isTargetFile(document)) return;

    const config = vscode.workspace.getConfiguration('agentTicketHighlighter');
    const prefix = getProjectPrefix(document);
    const numberingEnabled = config.get('enableTicketNumbering') !== false;
    const padding = config.get('idPadding') || 4;
    const ticketIndentation = clampInteger(config.get('ticketIndentation'), 4, 1);
    const descriptionIndentation = clampInteger(config.get('descriptionIndentation'), 2, 0);
    const id = number => numberingEnabled ? formatId(prefix, number, padding) : '';
    const prefixHeader = `[PREFIX: ${prefix}]`;
    const trackerTitle = formatTrackerTitle(inferProjectName(document));
    const ticketIndent = ' '.repeat(ticketIndentation);
    const descriptionIndent = ' '.repeat(descriptionIndentation);
    const ticketDescriptionIndent = ' '.repeat(ticketIndentation + descriptionIndentation);

    const templateText = `[HELP] Hover here for ticket rules and conventions.
[NOTIFICATION] No active ticket notifications.
[INFO] Hover here for the current ticket summary.
${prefixHeader}
================================================================================
${trackerTitle}
================================================================================
This file defines the project task lists. 
${numberingEnabled ? `To configure a custom project prefix, edit the [PREFIX: ${prefix}] tag above.` : 'Ticket numbering is disabled. Enable it in settings if this project needs ticket IDs.'}

RULES & CONVENTIONS:
--------------------------------------------------------------------------------
Prefixes (Start of line triggers):
  $- : Completed / final / no testing required
  @- : Working on it
  #- : Fixed and ready to test
  *- : Planned for later (Backlog)
  !- : Irrelevant or cancelled
  ^- : Fails testing / needs rework
  ~- : Epic / Milestones / Undecided

Tags (Inline badges):
  [BUG] or [B]   : Bug fixes
  [FT] or [F]    : New features
  [ENH] or [E]   : Improvements/enhancements
  [EPIC] or [EP] : Large milestones
  [SUB]           : Nested work item; indentation or -- expresses hierarchy
  [TEST]          : Test case with a child [LINK]
  [LINK]          : One or more workspace ticket references
  [NOTIFICATION]  : No active notice; [*NOTIFICATION] means attention is required
  [INFO]          : Hover-only live epic, status, and ticket summary

Description (Italics):
  [DESC] *Use description lines for additional details and file paths/attachments.*

Structure & wording:
  Every ticket belongs to an epic and uses a concise, professional title.
  Epic descriptions follow the epic immediately; the blank line follows the final epic [DESC].
  Review lingering #- tickets from later active verification, never from elapsed calendar time.
  Store new ticket evidence and support files under the workspace .tickets folder.
================================================================================

~- [EPIC]${id(1)} Phase 1: Core Setup
${descriptionIndent}[DESC] *Initial project setup and configuration.*

${ticketIndent}$- [FT]${id(2)} Create repository and install packages
${ticketIndent}@- [FT]${id(3)} Define core data models and database connection
${ticketDescriptionIndent}[DESC] *Database is SQLite. See schema details in database.js*
`;

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, fullRange, templateText);
    
    isEditing = true;
    vscode.workspace.applyEdit(workspaceEdit).then(() => {
      isEditing = false;
      updateDecorations(editor);
    }, () => {
      isEditing = false;
    });
  });
  context.subscriptions.push(initializeTemplateCommand);

  // Listeners
  vscode.window.onDidChangeActiveTextEditor(editor => {
    activeLinkEdit = null;
    activeEditor = editor;
    if (editor) {
      updateDecorations(editor);
      checkEmptyFile(editor.document);
      applyAutoEdits(editor, { contentChanges: [] });
      scheduleStructureNormalization(editor);
    }
    updateStatusBarVisibility(editor);
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeTextDocument(event => {
    if (activeEditor && event.document === activeEditor.document) {
      if (!isEditing && isTargetFile(event.document)) {
        for (const change of event.contentChanges) {
          const lineNumber = Math.min(change.range.start.line, event.document.lineCount - 1);
          if (lineNumber >= 0 && /^\s*\[LINK\]/i.test(event.document.lineAt(lineNumber).text)) {
            activeLinkEdit = { uri: event.document.uri.toString(), line: lineNumber };
            break;
          }
        }
      }
      updateDecorations(activeEditor);
      applyAutoEdits(activeEditor, event);
      scheduleRegistryRefresh();
      if (!isEditing) scheduleStructureNormalization(activeEditor);
    }
  }, null, context.subscriptions);

  vscode.workspace.onDidSaveTextDocument(document => {
    if (activeEditor && document === activeEditor.document && isTargetFile(document)) {
      scheduleStructureNormalization(activeEditor, 50);
    }
  }, null, context.subscriptions);

  vscode.window.onDidChangeTextEditorSelection(event => {
    if (!activeLinkEdit || event.textEditor !== activeEditor || !isTargetFile(event.textEditor.document)) return;
    if (activeLinkEdit.uri !== event.textEditor.document.uri.toString()) return;

    const stillEditingLink = selectionsContainLine(event.selections, activeLinkEdit.line);
    if (stillEditingLink) return;

    activeLinkEdit = null;
    applyAutoEdits(event.textEditor, { contentChanges: [] });
  }, null, context.subscriptions);

  const ticketWatcher = vscode.workspace.createFileSystemWatcher('**/*.{tickets,tkt}');
  ticketWatcher.onDidCreate(scheduleRegistryRefresh, null, context.subscriptions);
  ticketWatcher.onDidChange(scheduleRegistryRefresh, null, context.subscriptions);
  ticketWatcher.onDidDelete(scheduleRegistryRefresh, null, context.subscriptions);
  context.subscriptions.push(ticketWatcher, {
    dispose: () => {
      if (registryRefreshTimer) clearTimeout(registryRefreshTimer);
      if (structureTimer) clearTimeout(structureTimer);
    }
  });

  // Register DocumentLinkProvider for clickable paths and URLs
  let linkProvider = vscode.languages.registerDocumentLinkProvider({ scheme: 'file', language: 'agent-tracker' }, {
    provideDocumentLinks(document, token) {
      const links = [];
      const text = document.getText();
      const lines = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const commentIdx = line.indexOf('//');
        const descMatch = line.match(/^(\s*)\[(DESC|DESCRIPTION)\]/i);

        if (descMatch || commentIdx !== -1) {
          // 1. Match Web URLs and File URIs
          const urlRegex = /(https?:\/\/[^\s)\]]+|file:\/\/\/[^\s)\]]+)/g;
          let match;
          while ((match = urlRegex.exec(line)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            try {
              const targetUri = vscode.Uri.parse(match[0]);
              links.push(new vscode.DocumentLink(
                new vscode.Range(new vscode.Position(i, start), new vscode.Position(i, end)),
                targetUri
              ));
            } catch (e) {
              // Invalid URI
            }
          }

          // 2. Match Relative/Absolute File Paths
          const pathRegex = /(?:\.?\/)?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*/g;
          pathRegex.lastIndex = 0;
          while ((match = pathRegex.exec(line)) !== null) {
            const matchedText = match[0];
            if (matchedText.startsWith('http://') || matchedText.startsWith('https://') || matchedText.startsWith('file://')) {
              continue;
            }
            let fileUri;
            try {
              if (matchedText.startsWith('/') || matchedText.startsWith('file:')) {
                fileUri = vscode.Uri.file(matchedText);
              } else {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                if (workspaceFolder) {
                  fileUri = vscode.Uri.joinPath(workspaceFolder.uri, matchedText);
                } else {
                  const parentDir = vscode.Uri.joinPath(document.uri, '..');
                  fileUri = vscode.Uri.joinPath(parentDir, matchedText);
                }
              }
              const start = match.index;
              const end = start + matchedText.length;
              links.push(new vscode.DocumentLink(
                new vscode.Range(new vscode.Position(i, start), new vscode.Position(i, end)),
                fileUri
              ));
            } catch (e) {
              // Invalid path
            }
          }
        }
      }

      return links;
    }
  });
  context.subscriptions.push(linkProvider);

  function escapeHoverText(value) {
    return String(value || '').replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
  }

  function statusSummaryLabel(status, labels) {
    const prefix = status === '?' ? '?' : `${status}-`;
    return `\`${prefix}\` ${labels[status] || 'Unspecified'}`;
  }

  function createInfoHover(document) {
    const summary = buildTicketSummary(document.getText(), getFlowOptions(document));
    const info = new vscode.MarkdownString();
    info.appendMarkdown('### Current ticket summary\n\n');
    info.appendMarkdown(`**Epics:** ${summary.epicCount} &nbsp; **Tickets:** ${summary.ticketCount}\n\n`);
    info.appendMarkdown('| Status | Tickets |\n|:--|--:|\n');
    summary.statusOrder.forEach(status => {
      info.appendMarkdown(`| ${statusSummaryLabel(status, summary.statusLabels)} | ${summary.statusCounts[status] || 0} |\n`);
    });

    if (summary.ungrouped.length) {
      info.appendMarkdown(`\n> **Attention:** ${summary.ungrouped.length} ticket(s) are not currently grouped under an epic.\n\n`);
    }

    summary.epics.forEach((epic, epicIndex) => {
      const epicIdentity = epic.id ? `\`[${epic.id}]\` ` : '';
      info.appendMarkdown(`\n#### ${epicIndex + 1}. ${epicIdentity}${escapeHoverText(epic.title)}\n\n`);
      info.appendMarkdown(`**Epic status:** ${statusSummaryLabel(epic.status, summary.statusLabels)} &nbsp; **Tickets:** ${epic.tickets.length}\n\n`);
      if (epic.descriptions.length) {
        info.appendMarkdown(`_${escapeHoverText(epic.descriptions.join(' '))}_\n\n`);
      }
      if (!epic.tickets.length) {
        info.appendMarkdown('_No tickets under this epic._\n\n');
        return;
      }

      epic.tickets.forEach(ticket => {
        const nesting = ticket.depth > 0 ? `${'↳ '.repeat(ticket.depth)}` : '';
        const ticketIdentity = ticket.id ? `\`[${ticket.id}]\` ` : '';
        info.appendMarkdown(`- ${nesting}${statusSummaryLabel(ticket.status, summary.statusLabels)} · \`[${ticket.tag}]\` · ${ticketIdentity}${escapeHoverText(ticket.title)}\n`);
        if (ticket.descriptions.length) {
          info.appendMarkdown(`  - _${escapeHoverText(ticket.descriptions.join(' '))}_\n`);
        }
      });
      info.appendMarkdown('\n');
    });

    if (!summary.epics.length) {
      info.appendMarkdown('\n_No epics are currently defined._');
    }
    return info;
  }

  const helpProvider = vscode.languages.registerHoverProvider('agent-tracker', {
    async provideHover(document, position) {
      const line = document.lineAt(position.line).text;
      const start = line.indexOf('[HELP]');
      if (start !== -1 && position.character >= start && position.character <= start + 6) {
        const help = new vscode.MarkdownString();
        help.appendMarkdown('### Tickets rules and conventions\n\n');
        help.appendMarkdown('**Header:** every tracker starts with `[HELP]`, `[NOTIFICATION]`, `[INFO]`, `[PREFIX]`, and a framed project-specific title. The extension creates a workspace-name fallback; AI may refine it, and user-edited titles are preserved.\n\n');
        help.appendMarkdown('**Hierarchy:** every ticket belongs beneath an `[EPIC]`. Epic descriptions follow the epic immediately, and the blank boundary follows the final epic `[DESC]`. Direct epic children use the configured ticket indentation; deeper indentation or `--` marks nested work.\n\n');
        help.appendMarkdown('**Titles:** use concise, accurate, professional one-line summaries. Keep relevant request details in the owning epic or ticket `[DESC]`.\n\n');
        help.appendMarkdown('**Statuses:** `$-` completed · `@-` working · `#-` ready to test · `*-` planned · `!-` cancelled · `^-` failed · `~-` epic/undecided\n\n');
        help.appendMarkdown('**Tags:** `[BUG]` bug · `[FT]` feature · `[ENH]` enhancement · `[EPIC]` milestone · `[SUB]` nested work · `[TEST]` test case · `[LINK]` references · `[DESC]` detail\n\n');
        help.appendMarkdown('**Notifications:** `[*NOTIFICATION]` means hierarchy or semantic placement needs review. Each tracker uses a unique record below `.tickets/notifications/`, so notices never leak between ticket files.\n\n');
        help.appendMarkdown('**Support files:** store new ticket-specific evidence, links, attachments, and future artifacts under `.tickets/` instead of the project root. Existing project files may stay in their proper locations.\n\n');
        help.appendMarkdown('**Completion review:** project inactivity never completes a `#-` ticket. During later active work, notify first; only a subsequent fresh verification of stability may promote it to `$-`.\n\n');
        help.appendMarkdown('**Planned work:** when substantial active work has naturally paused, AI may briefly offer relevant `*-` or `~-` work. It should not repeat this during every response.\n\n');
        help.appendMarkdown('**Information:** hover `[INFO]` for live epic totals, ticket status counts, and detailed tickets grouped by epic.\n\n');
        help.appendMarkdown('**Test links:** a `[TEST]` needs a child `[LINK]`. Green references exist, red references do not, and orange means unresolved (`{nil}`).\n\n');
        help.appendMarkdown('Descriptions and end-of-line comments may contain clickable workspace paths and URLs.');
        return new vscode.Hover(help, new vscode.Range(position.line, start, position.line, start + 6));
      }

      const infoMatch = line.match(/^\s*\[INFO\]/i);
      if (infoMatch) {
        const infoStart = line.toUpperCase().indexOf('[INFO]');
        if (position.character >= infoStart && position.character <= infoStart + 6) {
          return new vscode.Hover(
            createInfoHover(document),
            new vscode.Range(position.line, infoStart, position.line, infoStart + 6)
          );
        }
      }

      const notificationMatch = line.match(/^\s*\[\*?NOTIFICATION\]/i);
      if (!notificationMatch || position.character < notificationMatch.index || position.character > notificationMatch.index + notificationMatch[0].length) {
        return undefined;
      }

      const options = getFlowOptions(document);
      const current = notificationState.get(document.uri.toString())
        || findHierarchyNotifications(document.getText(), options);
      const notice = new vscode.MarkdownString();
      notice.appendMarkdown(notificationMatch[0].startsWith('[*')
        ? '### Active ticket notifications\n\n'
        : '### Ticket notifications\n\nNo structural notifications are currently active.\n\n');
      if (current.length) {
        current.forEach(item => notice.appendMarkdown(`- ${item.message}\n`));
        notice.appendMarkdown('\n');
      }

      const notificationUri = getNotificationUri(document);
      if (notificationUri) {
        const notificationName = vscode.workspace.asRelativePath(notificationUri, false).replace(/`/g, '');
        notice.appendMarkdown(`**Record:** \`${notificationName}\`\n\n`);
        try {
          const record = Buffer.from(await vscode.workspace.fs.readFile(notificationUri)).toString('utf8');
          const recent = record.split(/\r?\n/).slice(-16).join('\n').trim();
          if (recent) {
            notice.appendMarkdown('**Recent record**\n\n');
            notice.appendCodeblock(recent, 'text');
          }
        } catch (_) {
          notice.appendMarkdown('The notification record will be created automatically when this file is normalized.');
        }
      }
      return new vscode.Hover(
        notice,
        new vscode.Range(position.line, notificationMatch.index, position.line, notificationMatch.index + notificationMatch[0].length)
      );
    }
  });
  context.subscriptions.push(helpProvider);

  function checkEmptyFile(document) {
    if (!document || !isTargetFile(document)) return;
    if (document.getText().trim() === '') {
      vscode.window.showInformationMessage(
        'This tickets file is empty. Would you like to initialize it with a starter template?',
        'Initialize Template'
      ).then(selection => {
        if (selection === 'Initialize Template') {
          vscode.commands.executeCommand('tickets-vibe-coding.initializeTemplate');
        }
      });
    }
  }

  vscode.workspace.onDidOpenTextDocument(doc => {
    checkEmptyFile(doc);
    if (activeEditor && doc === activeEditor.document) scheduleStructureNormalization(activeEditor);
  }, null, context.subscriptions);

  // Listen to configuration changes and re-initialize
  vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('agentTicketHighlighter')) {
      initDecorations();
      updateStatusBar();
      if (activeEditor) {
        updateDecorations(activeEditor);
        scheduleStructureNormalization(activeEditor, 50);
      }
    }
  }, null, context.subscriptions);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  __test: {
    shouldRestoreLinkPlaceholder,
    selectionsContainLine
  }
};
