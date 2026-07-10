const vscode = require('vscode');

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
  return (config.get('projectPrefix') || 'HLP').toUpperCase();
}

function getNextIdNumber(document, prefix) {
  const text = document.getText();
  const escapedPrefix = prefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp('\\[' + escapedPrefix + '-(?:[A-Z]+-)?(\\d+)\\]', 'gi');
  let maxNum = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
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

function activate(context) {
  let customRulesDecorations = [];
  let isEditing = false;

  // Default Decoration Types (we will recreate them when config changes)
  let decCompleted, decWorking, decReady, decPlanned, decCancelled, decFailed, decEpic;
  let decComment, decTagBug, decTagFeature, decTagEnh, decTagEpic, decTagDesc, decDescription;

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
          const range = new vscode.Range(new vscode.Position(i, rangeStart), new vscode.Position(i, rangeEnd));
          if (inheritedStatus === '$') listCompleted.push(range);
          else if (inheritedStatus === '@') listWorking.push(range);
          else if (inheritedStatus === '#') listReady.push(range);
          else if (inheritedStatus === '*') listPlanned.push(range);
          else if (inheritedStatus === '!') listCancelled.push(range);
          else if (inheritedStatus === '^') listFailed.push(range);
          else if (inheritedStatus === '~') listEpic.push(range);
        }
      }

      // Default Tags (Case-insensitive & explicitly ordered alternatives)
      const tagBugRegex = /\[(BUG|B|bug|b)\]/gi;
      const tagFeatureRegex = /\[(FT|F|ft|f)\]/gi;
      const tagEnhRegex = /\[(ENH|ENHANCEMENT|Enh|E|enh|e)\]/gi;
      const tagEpicRegex = /\[(EPIC|EP|epic|ep)\]/gi;
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
    const autoGenerate = config.get('autoGenerateIds') !== false;
    const prefix = getProjectPrefix(document);
    const padding = config.get('idPadding') || 4;

    const workspaceEdit = new vscode.WorkspaceEdit();
    let hasChanges = false;
    let nextId = null;

    function getNextId() {
      if (nextId === null) {
        nextId = getNextIdNumber(document, prefix);
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

      let workingText = commentIdx !== -1 ? replacedCode + text.substring(commentIdx) : replacedCode;

      // 2. Auto-generate ID
      if (autoGenerate) {
        const trimmed = workingText.trim();
        if (!trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
          const ticketMatch = workingText.match(/^(\s*[$@#*!^~]-\s*)(?:\[(BUG|B|FT|F|ENH|E|EPIC|EP)\])?/i);
          if (ticketMatch) {
            const escapedPrefix = prefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const idRegex = new RegExp('\\[' + escapedPrefix + '-(?:[A-Z]+-)?\\d+\\]', 'i');

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

    if (hasChanges) {
      isEditing = true;
      vscode.workspace.applyEdit(workspaceEdit).then(() => {
        isEditing = false;
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
  }

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
    let nextId = getNextIdNumber(document, prefix);

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      let text = line.text;

      const trimmed = text.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('===') || trimmed.startsWith('---')) {
        continue;
      }

      const ticketMatch = text.match(/^(\s*[$@#*!^~]-\s*)(?:\[(BUG|B|FT|F|ENH|E|EPIC|EP)\])?/i);
      if (!ticketMatch) continue;

      const escapedPrefix = prefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const idRegex = new RegExp('\\[' + escapedPrefix + '-(?:[A-Z]+-)?\\d+\\]', 'i');
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

    const prefixSetting = vscode.workspace.getConfiguration('agentTicketHighlighter').get('projectPrefix') || 'HLP';
    const prefix = prefixSetting.toUpperCase();

    const templateText = `================================================================================
[PREFIX: ${prefix}]
TICKETS - BUG & SUGGESTION TRACKER
================================================================================
This file defines the project task lists. 
To configure a custom project prefix, edit the [PREFIX: ${prefix}] tag above.

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

Description (Italics):
  [DESC] *Use description lines for additional details and file paths/attachments.*
================================================================================

~- [EPIC][${prefix}-0001] Phase 1: Core Setup
  [DESC] *Initial project setup and configuration.*
  $- [FT][${prefix}-0002] Create repository and install packages
  @- [FT][${prefix}-0003] Define core data models and database connection
  [DESC] *Database is SQLite. See schema details in database.js*
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
    activeEditor = editor;
    if (editor) {
      updateDecorations(editor);
      checkEmptyFile(editor.document);
    }
    updateStatusBarVisibility(editor);
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeTextDocument(event => {
    if (activeEditor && event.document === activeEditor.document) {
      updateDecorations(activeEditor);
      applyAutoEdits(activeEditor, event);
    }
  }, null, context.subscriptions);

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
  }, null, context.subscriptions);

  // Listen to configuration changes and re-initialize
  vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('agentTicketHighlighter')) {
      initDecorations();
      updateStatusBar();
      if (activeEditor) {
        updateDecorations(activeEditor);
      }
    }
  }, null, context.subscriptions);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
