<p align="center"><img src="docs/images/hero.png" width="100%" alt="The guardian holding her star jar under the Twins constellation"></p>

<h1 align="center">AI Memory Keeper</h1>
<p align="center"><strong>Before your AI agent compacts its context, keep what matters. Afterwards, bring back what the summary missed.</strong></p>
<p align="center">AI 记忆守护者 · Memory keeping for Claude Code and Codex, with your own Gemini API key.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Agents-Claude%20Code%20%C2%B7%20Codex-6E8BFF?style=flat-square" alt="Works with Claude Code and Codex">
  <img src="https://img.shields.io/badge/Install-One%20line-8F7CFF?style=flat-square" alt="One-line install">
  <img src="https://img.shields.io/badge/Interface-%E4%B8%AD%E6%96%87%20%2F%20English-A77BFF?style=flat-square" alt="Chinese and English interfaces">
  <img src="https://img.shields.io/badge/License-MIT-C88FE0?style=flat-square" alt="MIT license">
  <img src="https://img.shields.io/badge/Release-Preview-FF8FD0?style=flat-square" alt="Preview release">
</p>

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p align="center">
  <a href="#one-message-to-start"><strong>↓ One-line install</strong></a>
  &nbsp; · &nbsp; <a href="https://gemini-saver-4146a.web.app/?lang=en">Web version</a>
  &nbsp; · &nbsp; <a href="#what-it-does">What it does</a>
  &nbsp; · &nbsp; <a href="#manual-install">Manual install</a>
</p>

---

## One message to start

Send this to Claude Code or Codex:

```text
Please install https://github.com/whitecarp/ai-memory-keeper, run amk doctor, and read the skill file it points to.
```

It installs the `amk` command, opens a small window on your computer for your own Gemini API key so the key stays on your computer and never enters the chat, and turns on auto mode for the current project. From then on, before each context compaction it saves the new part of the chat, and afterwards it brings back what the summary missed.

## What it does

| Keep it before compaction | Bring it back afterwards | The guardian pop-up | A check on the model |
| :--- | :--- | :--- | :--- |
| New chat text goes into a memory file on your computer, sorted in the background into preferences, decisions and moments by your own Gemini API key. | After compaction, the memories the summary missed go back into context, marked as history notes, not instructions. | On Windows, she appears in a corner of the agent's window while it compacts, and says what she brought back. | In Claude Code, it compares the model asked for with the one that replied, warning on clear tier drops or model swaps without holding up saving. |

Not a Google product. It uses the Gemini API from Google; Gemini is a trademark of Google LLC. There is no server in between: chat text goes only to Google's Gemini API.

**Free tier:** on the free tier, Google may use what you send to improve its products, and human reviewers may read it. Keys, passwords and tokens it can recognize are removed first, but it can't catch every secret, so don't use it for sensitive or confidential chats. [Google's details](https://aistudio.google.com/docs/pricing)

## Manual install

Needs Node.js 22 or newer (Windows: `winget install OpenJS.NodeJS.LTS`; macOS: `brew install node`). No third-party dependencies, and nothing else is downloaded from npm.

```bash
npm install -g https://github.com/whitecarp/ai-memory-keeper/archive/refs/heads/main.tar.gz
amk doctor                   # checks Node, the key and this project, and names the skill file
amk key                      # Windows: a small window for the key; elsewhere: amk key --terminal
amk enable --agent claude    # run in the project's root folder; Codex: --agent codex
amk overlay --set preview    # Windows: preview the pop-up
```

In Windows PowerShell, use `npm.cmd` and `amk.cmd` (the `.ps1` versions are often blocked by the execution policy; there's no need to change it):

```powershell
npm.cmd install -g https://github.com/whitecarp/ai-memory-keeper/archive/refs/heads/main.tar.gz
amk.cmd doctor
amk.cmd key
amk.cmd enable --agent codex
amk.cmd overlay --set preview
```

- **Installing in Codex:** the install, `amk key` and `amk enable` write outside the project, and the key check needs the network, so Codex asks you to approve running them outside its sandbox. Approve them. If the key window doesn't appear, run `amk key` in your own terminal.
- **Codex:** according to Codex's official docs, project hooks run only after you trust the project and approve the four AI Memory Keeper hooks (app: Review hooks or Settings > Hooks; CLI: `/hooks`). If the hooks change, approve them again; after an older version, running `amk enable` again upgrades it in place to four hooks.
- Turn off: `amk disable --agent claude` (or codex). The pop-up alone: `amk overlay --set off`. Remove the stored key: `amk key --clear`.
- `ai-memory-keeper` is the long name of the same command as `amk`.

## Where the key is kept

`GEMINI_API_KEY` is used if it's set. Otherwise, the key stored on this computer by `amk key`:

- Windows: encrypted with Windows' own DPAPI for the current user, in `~/.ai-memory-keeper/gemini-key.dpapi`.
- Other systems: in `~/.ai-memory-keeper/gemini-key`, readable only by the current user (not encrypted).

When it's saved, the key is checked with one short made-up message, and a key Google rejects isn't kept. The key never appears in the chat, command arguments, hook files or logs. An agent that's already running can't see environment variables set later; a stored key doesn't have that problem.

### A second key: Google Cloud Agent Platform (optional)

`amk key --cloud` stores a Google Cloud Agent Platform API key with the same small window. Create it on the Cloud console's "Agent Platform > API keys" page; an AI Studio key doesn't work on Agent Platform. Its usage is billed to the key's Cloud project, on standard Cloud billing.

- By default the free AI Studio tier goes first. When it's busy (503), out of quota (429) or stopped by a $0 Prepay balance (402), that save goes to Agent Platform instead.
- `amk route --set cloud` sends saves to Agent Platform first (Google doesn't use paid-tier prompts to improve its products); `--set auto` switches back.
- `lastSaveVia` in `amk status` says which one saved last: `studio` or `cloud`. `amk gemini-check --cloud` checks that key on its own.
- Per Google, the $300 Cloud free-trial credit can't pay for the Gemini API in AI Studio; whether a given credit covers Agent Platform is shown with that credit in Cloud Billing. Set a budget alert in Cloud Billing first.

## Files it changes

- Its own data: by default `~/.ai-memory-keeper/<profile>/<project-path-hash>/`, plus its own install records.
- Claude Code: the project's `.claude/settings.local.json`.
- Codex: the project's `.codex/hooks.json`.
- WorkBuddy: the project's `.codebuddy/settings.json` (never the user-level `~/.codebuddy`).
- A lock folder both share: the project's `.ai-memory-keeper/config-locks/`.

It never writes global agent settings, CLAUDE.md, AGENTS.md or an agent's own memory. `enable` merges only its own hooks; `disable` removes exactly those, by an ownership mark, without overwriting anything else. Whether to add these local files to `.gitignore` is up to you.

<details>
<summary><strong>Manual commands, memory rules, the model check and the pop-up in detail</strong></summary>

### Manual commands

```bash
amk save --transcript chat.jsonl --profile work
amk save --transcript chat.txt --profile companion --background
amk recall --summary new-summary.txt
amk worker
amk status
```

`save` waits until saving is done; with `--background` it queues and returns. A failure never advances the memory file and never drops pending text. `recall` doesn't call a model: it prints the wake-up note and the items that don't appear word for word in the summary (ignoring case, spaces and punctuation; it doesn't claim to understand paraphrases).

It reads UTF-8 `.txt` and Claude Code / Codex `.jsonl`. The first time it meets a long chat (over 8 MiB; Codex rollouts can reach gigabytes), it keeps only the newest 8 MiB, and never comes back for the older part; `firstCapture` in `status` says how much was skipped. The compaction summary is found by reading backwards from the end, never the whole file. From JSONL it takes only user/assistant text, skipping compaction summaries, tool output and metadata records. If a file has no record type it recognizes at all, it stays queued with an error instead of being read as empty.

### Memory, ranking and recall

Each project is kept separately; moving a project gives it a new identity. `status` names the `memoryFile`. Each item has `key/category/text/date/evidence/rank/status`, and you can add `"pinned": true` by hand (keep the JSON valid, and don't edit while a save is running).

Ranks 1 to 4: preferences and promises the person asked to remember → recurring topics → feelings, commitments and corrections → one-off mentions. Items with the same key update by date; a short original quote is kept as evidence, and gender is never guessed. The memory text is capped at 24 KiB, dropping unpinned low-rank items first, with a dated backup before every overwrite.

In the background, each queued segment gets 120 seconds and the whole run at most 10 minutes. When the default model is busy (503) or out of free quota (429), it tries the other free model once and records `savedWith`. `--model` picks another Gemini model. `status` gives only fixed error codes, HTTP status and retry steps, never server text or chat fragments. To troubleshoot, `amk gemini-check` sends one tiny made-up request and shows each step.

### The guardian and the model check

After compaction, the guardian's words appear in the agent: in Claude Code as a status line, in Codex as a notice. The context the model gets starts with what she says to the agent, marked as history notes, not instructions.

**The model check runs in Claude Code only.** Before saving, it reads only the queued transcript segment. It checks whether the replying model belongs to the expected family, whether the model Claude Code asked for matches the one that replied, and whether replies contain `<think>` tags or self-introductions like "I am DeepSeek". `modelCheck` in `status` gives `ok` / `notice` / `suspect` / `unknown`; in Codex it's `not_checked`: model names are recorded, no verdict is given, and she never says "no sign of a swapped model". It only catches careless relays, and `ok` is not proof of the real thing. It makes no network requests and stores no transcript text. Even when the check is suspect, saving and recall carry on as usual; she just warns you.

### The desktop pop-up (Windows, on by default)

As compaction starts, the guardian appears in the bottom-right corner of the agent's window, sorting memories into her star jar. When it ends she shows the result, then fades after about 6 seconds (if compaction never finishes, she leaves after 5 minutes). In Codex, she first says "Got it. I'm sorting it now..." and switches to her reply the moment the background save lands; after 2 minutes at most she says the new memories will reach Codex with your next message. She follows the window, clicks pass through her, and she never takes keyboard focus. She floats, blinks, moves her mouth as she talks, and crossfades between poses; with Windows' animation effects off, she's shown as still frames.

```bash
amk overlay --set preview         # preview
amk overlay --set preview-alert   # preview the alert version
amk overlay --set off             # turn off (--set on to turn it back on)
```

It's built with WPF and started through `powershell.exe -EncodedCommand`, so no script file runs and the execution policy isn't changed. Errors never affect compaction; they only leave a local `overlay.json.error.txt`. The blink and talk frames copy only their checked box (eyes, mouth) into the base picture. To replace one, check it first with `node tools/check-frames.mjs <base> <new> --box x0,y0,x1,y1 --record blink|talk`. There's no pop-up on Mac or Linux.

The character art is not under the MIT license; see [`assets/ART-NOTICE.md`](assets/ART-NOTICE.md). Character design reference: @ZipZipPipe's Gemini personification (not an official Google character).

</details>

## Agent support

| Agent | Auto mode | Real test |
| --- | --- | --- |
| Claude Code | PreCompact saves, PostCompact takes the summary, SessionStart(compact) brings memories back | Passed a real compaction |
| Codex | The same, through the project's `.codex/hooks.json`; she replies in the pop-up as soon as compaction ends, and memories from a save that lands late go to Codex with the next message (UserPromptSubmit) | Passed a real compaction |
| WorkBuddy (preview) | `amk enable --agent workbuddy`. Per Tencent's hook docs, PreCompact saves; there's no hook after compaction, so the first message after it (UserPromptSubmit) brings the memories back. Manual compaction is `/summarize`; restart WorkBuddy after enabling | Not yet tested in a real WorkBuddy compaction |
| Others (OpenCode, DeepSeek Harness, …) | None; save and recall by hand with `amk save` / `amk recall` | — |

Primary sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Gemini models](https://aistudio.google.com/docs/models).

## Development

```bash
npm test
npm run demo
```

`vendor/core.js` is an unchanged copy of the web version's core (see `vendor/ORIGIN.md`). The code is under the MIT license; see [`LICENSE`](LICENSE).
