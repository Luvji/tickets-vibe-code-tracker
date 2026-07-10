# Tickets - vibe coding issue tracker & management

A text-based ticket tracking system. A lightweight, fast, and local ticket management system designed for solo, indie, and hobbyist developers. It is built to optimize **vibe coding** and **AI-assisted development**, providing instant visual cues and structured workflows when pair-programming with AI agents (like Antigravity, Cursor, Claude Code, and others).

No complex databases, servers, or configurations required. Simply keep a `.tickets` or `.tkt` file in your workspace, and let the color-coded highlighter keep you and your AI assistant perfectly aligned.

![Extension Showcase Screenshot](preview.png)

*   **100% Offline & Local**: Files stay in your project directory.
*   **Automated Ticket Numbering**: Automatically generates and appends unified, padded task IDs (e.g., `[HLP-0001]`).
*   **Rich Description & File Attachments**: Supports description lines with clickable paths and URLs to attach mockups, logs, screenshots, or code files.
*   **AI Agent Friendly**: Includes an updated built-in system prompt to teach any AI coder how to interact with your tickets, verify tasks, and create new tickets automatically.
*   **Case Normalization**: Automatically converts lowercase tags (like `[b]`, `[ft]`, `[desc]`) to uppercase badges as you type.
*   **Fully Customizable**: Change default colors via settings or add your own custom prefix/tag rules with ease.

📬 Contact / Feedback: jihad.k.m@gmail.com

---

## 🎨 Default Rules & Syntax

This extension applies highlighting to lines starting with the following status prefixes:

*   `$-` ➔ **Completed** (Finalized / Green)
*   `@-` ➔ **In Progress** (Working on it / Orange)
*   `#-` ➔ **Fixed / Ready for Test** (Needs testing / Cyan)
*   `*-` ➔ *Planned for Later* (Backlog / Muted Gray)
*   `!-` ➔ ~~Cancelled / Irrelevant~~ (Strikethrough Gray)
*   `^-` ➔ **Failed Testing / Rework** (Needs fixes / Bold Red with Red background)
*   `~-` ➔ **Epic / Undecided** (Needs discussion / Purple)

### Inline Tags
*   `[BUG]` or `[B]` ➔ Red badge
*   `[FT]` or `[F]` ➔ Violet badge (auto-normalizes from `[ft]` or `[f]`)
*   `[ENH]` or `[E]` ➔ Blue badge (auto-normalizes from `[enh]`)
*   `[EPIC]` or `[EP]` ➔ Purple badge (auto-normalizes from `[epic]`)
*   `[DESC]` ➔ Teal badge (auto-normalizes from `[desc]` or `[description]`) for description lines.

### Ticket Numbering
Tickets are automatically assigned a unique, padded ID of the format `[<PREFIX>-<NUMBER>]` (e.g., `[HLP-0001]`). 
- **Prefix Configuration**: Configure the prefix by writing a line at the top of your file (e.g., `[PREFIX: HLP]`). If not present, the extension falls back to your VS Code settings prefix configuration (default: `HLP`).
- **Padded Counters**: The numbering system uses a unified auto-incrementing counter with customizable padding width (default: 4 digits).
- **Auto-Generation**: As you type a ticket prefix or tag, the extension automatically appends the next sequential ID. You can also run the command **`Tickets: Generate Missing Ticket IDs`** to number all tickets in the document.

### Description Lines & Clickable Attachments
Use `[DESC]` at the start of a line to provide detail or attach files. 
- Descriptions are automatically styled in italics with a soft slate color.
- File paths (e.g. `docs/design.png`, `server.js`) and URLs (e.g. `https://github.com`) inside descriptions are clickable. Hold `Ctrl` (or `Cmd` on Mac) and click to open them directly in VS Code!

---

## 📋 Example Ticket File (`sample.tickets`)

Save the following content as `tasks.tickets` or `tasks.tkt` to see the formatting in action:

```text
[PREFIX: HLP]
================================================================================
TICKETS - BUG & SUGGESTION TRACKER
================================================================================

~- [EPIC][HLP-0001] Phase 1: Authentication & Layout
  [DESC] *Core modules for user auth. See design mockup in docs/design.png*
  $- [FT][HLP-0002] Initial user registration and password hashing // Complete
  $- [FT][HLP-0003] Responsive dashboard panel with glassmorphism theme // Complete
  @- [FT][HLP-0004] OAuth integration with Google & Github // Working on config
  #- [BUG][HLP-0005] Fix login spinner hang on slow network connections
  [DESC] *Test on slow 3G network simulation. Refer to log details in logs/auth.log*
  ^- [BUG][HLP-0006] Profile avatar upload exceeds memory limit on large files
  [DESC] *Fails on files > 10MB. Public spec link: https://api.example.com/uploads*

~- [EPIC][HLP-0007] Phase 2: Billing & Subscriptions
  *- [FT][HLP-0008] Integrate Stripe payment gateway
  *- [ENH][HLP-0009] Add support for recurring monthly subscriptions // Backlog item

!- [FT][HLP-0010] Legacy XML data parser migration // Cancelled (switching to JSON APIs)
```

---

## ⚙️ Custom Configurations (Settings)

Customize the extension's behavior in your global `settings.json`:

```json
{
  // Project-specific prefix for ticket numbers
  "agentTicketHighlighter.projectPrefix": "HLP",

  // Padding width for ticket IDs (4 results in 0001, 5 in 00001)
  "agentTicketHighlighter.idPadding": 4,

  // Automatically append IDs when typing a status prefix/tag
  "agentTicketHighlighter.autoGenerateIds": true,

  // Highlight the full line instead of just the status prefix
  "agentTicketHighlighter.highlightFullLine": false,

  // Customize default status colors
  "agentTicketHighlighter.colors.completed": "#10b981",
  "agentTicketHighlighter.colors.working": "#fb923c"
}
```

---

## 🎛️ Command Palette & Status Bar

- **Initialize Starter Template**: When opening an empty `.tickets` file, you will be prompted to initialize it. You can also run **`Tickets: Initialize Template`** from the Command Palette.
- **Generate Missing IDs**: Run **`Tickets: Generate Missing Ticket IDs`** to automatically add unique IDs to any unnumbered tickets.
- **Toggle Highlighting Mode**: Click the status bar item in the bottom right corner (e.g. `Tickets: Prefix Only`) or run **`Tickets: Toggle Full Line Highlighting`** to toggle full line highlights.

---

## 🤖 System Prompt for AI Agents

Copy and paste this prompt when starting a chat with any AI assistant (like Antigravity, Claude Code, or Copilot) to ensure it handles your ticket tracking files correctly:

```text
You are working on a project that utilizes a custom ticket/bug tracking format stored in files with extension '.tickets' or '.tkt' (e.g., 'bugtracker.tickets').

Please adhere to the following rules when reading, analyzing, or modifying these files:

1. Always read the '.tickets' file at the start of your turn to review issues, features, and logs before making changes.
2. Update the status prefixes at the start of lines to reflect your progress:
   - Use '@-' as prefix if you are currently working on an issue/feature.
   - Use '#-' as prefix when you have completed a fix/feature and it is ready for testing.
   - Use '*-' for items planned for later.
   - Use '!-' for cancelled or irrelevant items.
   - Use '$-' for items that are completed, final, and require no further testing.
   - Use '^-' if an item has failed testing and needs rework.
   - Use '~-' if an item is read but not yet decided on, or needs further epic-level planning.
3. Every ticket line (starts with a status prefix) must have a unique identifier of the format '[<PREFIX>-<NUMBER>]' (e.g., '[HLP-0001]') placed right after the tag (if present) or status prefix.
4. If the human user asks you to work on something, do something, or plan changes, you MUST:
   a. Check the '.tickets' file first to see if there is an existing, relevant ticket.
   b. If you find a relevant ticket, ask the user to verify if the task is related (e.g. "Is this related to ticket [HLP-0001]?"). If verified, change its status to '@-' and update it as you work.
   c. If you do NOT find a relevant ticket, or if the user confirms that the suggested tickets are not relevant, you MUST create a new ticket in the file first with a new auto-incremented ID, and inform the user of the new ticket number before writing code.
5. Ticket descriptions can be added on subsequent lines using the '[DESC]' tag (auto-normalized from '[desc]' or '[description]'). 
   - Descriptions might contain paths to related files (e.g., UserStories, Project Documents, bug evidences, screenshots, code files, logs) or public URLs.
   - As an AI agent, you must go through and read these referenced files or URLs when necessary to solve tasks.
   - If the referenced path is broken or unavailable, you must inform the human user and ask for the correct path.
   - If you are unable to process the data, you must seek how to process and ask human to decide to continue or not or how to proceed.
6. If the tickets file is empty when starting, you must automatically analyze the workspace files (directory structure, package.json, source files, etc.) to understand the project structure, suggest a prefix, propose a starter list of tickets, and ask the user for a description/direction to populate the file and initialize the workflow.
7. Do NOT rewrite, paraphrase, or randomly edit the human user's original task text. Prepend/insert the appropriate status prefixes, tags, IDs, and append comments (e.g., '// Completed') at the end of the line.
8. Maintain task hierarchies using indentation (tabs/spaces as sub divisions) and bullet dashes ('-', '--', '---' etc. as subpoints). Incrementing the dashes creates deeper nesting. Subpoints automatically inherit the status prefix of their parent task unless explicitly marked.
9. Keep the 'README.md' and the '.tickets' files updated as features are built.
```

---

## 📄 License
This extension is licensed under the [MIT License](LICENSE).
