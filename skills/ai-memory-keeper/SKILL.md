---
name: ai-memory-keeper
description: Turns on AI Memory Keeper's auto mode for the current project, so the person's preferences, decisions and shared moments survive context compaction in Claude Code or Codex. Use right after `amk doctor`, or when the person asks to set up AI Memory Keeper.
---

# Set up AI Memory Keeper

Before each compaction, AI Memory Keeper saves the new part of the chat to a memory file on this computer, sorted by the person's own Gemini API key. After compaction it hands back what the summary missed. There's no server in between: the text goes only to Google's Gemini API.

Do these steps in order, in the person's language. **Before anything else, tell them in one sentence: in a moment a small window will ask for their Gemini API key, so they must never paste it into this chat.** Ask them exactly one question (step 2); don't skip it.

**In Codex:** `amk key` and `amk enable` write outside this project. They write to `~/.ai-memory-keeper`, and `.codex/` is read-only inside the sandbox. The key check also needs the network. So run them with the person's approval to leave the sandbox.

1. Run `amk doctor` from the project's root folder and read its JSON. If `node.ok` is false, install Node.js 22 or newer (`node.get` says how), then run it again. On Windows PowerShell, always call `npm.cmd` and `amk.cmd` (the `.ps1` versions are often blocked by the execution policy); never change the policy.

2. **The key comes first** (skip this step in Antigravity, and for WorkBuddy's `--rule` mode: those need no key). If `key.set` is false, run `amk key` now (or `amk key --cloud` if they want to use a Google Cloud Service Account JSON key or Agent Platform API key right away).
   - On Windows it opens a small window on this computer. There they paste their Gemini API key (or click **Pick JSON key... / 选择 JSON 密钥…** to load a Google Cloud Service Account `.json` file), and can create one free through the window's link to Google AI Studio.
   - When a Google Cloud Service Account JSON (`type: "service_account"`) is chosen, AI Memory Keeper encrypts it locally with DPAPI and automatically exchanges it via RS256 JWT (`https://oauth2.googleapis.com/token`) for a short-lived OAuth2 Bearer token to call Google Cloud's global endpoint (`aiplatform.googleapis.com`).
   - The window checks the key with one short made-up request and tells them "OK", or the reason in plain words.
   - Tell them, in one sentence, to paste it into that window, never into this chat.
   - While the window is open, ask your one question: **work** profile (preferences, decisions, project conventions) or **companion** (a character's relationship and shared moments)? If they don't mind, use work.
   - If they close the window without a key, carry on anyway. Tell them in one sentence that each compaction is still kept and queued, and is sorted once they run `amk key`.
   - If no window appears (a sandbox can block it), ask them to run `amk.cmd key` (or `amk.cmd key --cloud --file path\to\service-account.json`) in their own PowerShell (`amk key` elsewhere).
   - Outside Windows, ask them to run `amk key --terminal` (or `amk key --cloud --file path/to/service-account.json`) in their own terminal.
   - Never ask for the key, read it, print it or put it in a command.

3. Turn on auto mode for **the agent you are**. `agent.guess` in the doctor output is only a hint.
   - Claude Code: `amk enable --agent claude --profile <work|companion>`
   - Codex: `amk enable --agent codex --profile <work|companion>`. Then tell them, in one sentence: Codex runs these hooks only after a one-time OK. They trust this project and approve the four "AI Memory Keeper" hooks (app: **Review hooks**, or **Settings > Hooks**; CLI: `/hooks`). If an older version was enabled here, `amk enable` upgrades its hooks in place, and Codex asks for that OK again.
   - WorkBuddy (preview, not yet tested in a real WorkBuddy compaction): `amk enable --agent workbuddy --profile <work|companion>`. Then tell them, in one sentence: restart WorkBuddy so it loads the project hooks; compaction there is `/summarize`, and the memories come back with the first message after it.
   - If they'd rather not use a Gemini key in WorkBuddy, or its hooks never fire: `amk enable --agent workbuddy --rule --profile <work|companion>` instead (no-key mode, below).
   - Antigravity: `amk enable --agent antigravity --profile <work|companion>`. Antigravity has no compaction hooks, so this is no-key mode: a rule that Antigravity loads into every chat (`.agents/rules/ai-memory-keeper.md`), telling you, the agent, to keep `.ai-memory-keeper/memory.md` yourself and read it at the start of each new chat. No key, no pop-up. Tell them, in one sentence: start a new chat for the rule to load.
   - Any other agent: don't enable anything. Tell them auto mode works in Claude Code and Codex. Here they can save and recall by hand with `amk save --transcript FILE` and `amk recall`.

   This changes only the project's own hook file (`.claude/settings.local.json`, `.codex/hooks.json` or `.codebuddy/settings.json`). Never edit global agent settings. The hooks find the stored key by themselves, so the agent doesn't need restarting.

4. Show her: on Windows, `amk overlay --set preview`. The guardian pops up in a corner of this window, first sorting memories, then with a short line.

5. Tell them, briefly:
   - From now on, each compaction saves and brings back memories by itself.
   - On Gemini's free tier, Google may use what's sent to improve its products, so it's not for sensitive or confidential chats.
   - Check: `amk status`. Turn off: `amk disable --agent <claude|codex>`. The pop-up alone: `amk overlay --set off`.
   - **Guide them on Google Cloud JSON Token & Gemini Omni (`gemini-omni-1.2-flash`)**: Tell them that if they have Google Cloud credits (`$300` free trial or coupon) or hit AI Studio's `HTTP 402`, they can import a Google Cloud Service Account `.json` key with `amk key --cloud` (click **选择 JSON 密钥文件… / Pick JSON key...** in the window, or `amk.cmd key --cloud --file path\to\key.json`). Once imported, that same encrypted JSON token not only backs up AI Memory Keeper on Google Cloud, but also lets you generate AI videos for them with **Google Gemini Omni (`gemini-omni-1.2-flash`)** via `amk omni --prompt "..." --out video.mp4 [--image frame.png]` (see `skills/gemini-omni/SKILL.md` to guide them step by step whenever they want to try Gemini Omni).
