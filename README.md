<h1 align="center">AI 记忆守护者</h1>
<p align="center"><strong>上下文压缩前，先替你的 AI 收好重要的事；压缩完，再把摘要漏掉的带回来。</strong></p>
<p align="center">AI Memory Keeper · 给 Claude Code 和 Codex 的记忆守护，用你自己的 Gemini API key。</p>

<p align="center">
  <img src="https://img.shields.io/badge/%E4%BB%A3%E7%90%86-Claude%20Code%20%C2%B7%20Codex-6E8BFF?style=flat-square" alt="支持 Claude Code 和 Codex">
  <img src="https://img.shields.io/badge/%E5%AE%89%E8%A3%85-%E4%B8%80%E5%8F%A5%E8%AF%9D-8F7CFF?style=flat-square" alt="一句话安装">
  <img src="https://img.shields.io/badge/%E7%95%8C%E9%9D%A2-%E4%B8%AD%E6%96%87%20%2F%20English-A77BFF?style=flat-square" alt="中文和英文界面">
  <img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-MIT-C88FE0?style=flat-square" alt="MIT 许可">
  <img src="https://img.shields.io/badge/%E7%89%88%E6%9C%AC-%E9%A2%84%E8%A7%88%E7%89%88-FF8FD0?style=flat-square" alt="预览版">
</p>

<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
<p align="center">
  <a href="#一句话开始"><strong>↓ 一句话安装</strong></a>
  &nbsp; · &nbsp; <a href="https://gemini-saver-4146a.web.app/">网页版</a>
  &nbsp; · &nbsp; <a href="#它会做什么">它会做什么</a>
  &nbsp; · &nbsp; <a href="#手动安装">手动安装</a>
</p>

---

## 一句话开始

把下面这句话发给你的 AI 助手（Claude Code 或 Codex）：

```text
请安装 https://github.com/whitecarp/ai-memory-keeper ，运行 amk doctor，读取它给出的 skill 文件。
```

它会装好 `amk` 命令，先在你的电脑上弹出一个小窗口，让你填自己的 Gemini API key（key 只存在你的电脑上，不进聊天），再在当前项目里打开自动守护。之后每次上下文压缩，它都会先把新内容收好，压缩完再把摘要漏掉的记忆带回来。

## 它会做什么

| 压缩前，先收好 | 压缩后，带回来 | 守护者弹窗 | 顺便核对模型 |
| :--- | :--- | :--- | :--- |
| 新的聊天内容先存进你电脑上的记忆文件，在后台用你的 Gemini API key 整理成偏好、约定和经历。 | 压缩完，摘要漏掉的记忆自动带回上下文，注明是历史笔记、不是指令。 | Windows 上，压缩时她出现在代理窗口一角，说她带回了什么。 | Claude Code 里比对“要的模型”和“回复的模型”，不一致就提醒你。 |

不是 Google 产品。使用 Google 提供的 Gemini API；Gemini 是 Google LLC 的商标。没有中转服务器：聊天内容只发往 Google 的 Gemini API。

**免费额度提醒：** Google 免费额度下可能会用提交的内容改进产品，人工审核员可能会看到。发送前会去掉能认出的密钥、密码和令牌，但不能保证全部认出，不要用于敏感或机密的聊天。[Google 的说明](https://aistudio.google.com/docs/pricing)

## 手动安装

需要 Node.js 22 或更高版本（Windows：`winget install OpenJS.NodeJS.LTS`；macOS：`brew install node`）。没有第三方依赖，也不从 npm 下载别的包。

```bash
npm install -g https://github.com/whitecarp/ai-memory-keeper/archive/refs/heads/main.tar.gz
amk doctor                   # 检查 Node、key、当前项目，并给出 skill 文件路径
amk key                      # Windows：弹出小窗口填 key；其他系统用 amk key --terminal
amk enable --agent claude    # 在项目根目录运行；Codex 用 --agent codex
amk overlay --set preview    # Windows：预览弹窗
```

- Windows PowerShell 拦截 `amk`（执行策略）时，改用 `amk.cmd`，不需要改执行策略。
- **在 Codex 里安装：** 安装命令、`amk key` 和 `amk enable` 会写到项目外面，key 的检查要联网，所以 Codex 会请你批准它们在沙盒外运行，批准即可。小窗口没出现时，在你自己的终端里运行 `amk key`。
- **Codex：** 按 Codex 官方文档，项目钩子要等你信任这个项目，并批准这三个 AI Memory Keeper 钩子之后才会运行（App 用 Review hooks 或 Settings > Hooks；CLI 用 `/hooks`）。钩子内容一变就要重新批准。
- 关掉：`amk disable --agent claude`（或 codex）。只关弹窗：`amk overlay --set off`。删掉存的 key：`amk key --clear`。
- 长命令名 `ai-memory-keeper` 和 `amk` 是同一个命令。

## key 存在哪

优先用环境变量 `GEMINI_API_KEY`；没有的话，用 `amk key` 存在本机的 key：

- Windows：用 Windows 自带的 DPAPI 为当前用户加密，存在 `~/.ai-memory-keeper/gemini-key.dpapi`。
- 其他系统：存在 `~/.ai-memory-keeper/gemini-key`，只有当前用户能读（不加密）。

保存时会用一条很短的编造消息检查这个 key，Google 不接受的 key 不会留下。key 不会出现在聊天、命令参数、钩子文件或日志里。已经在运行的代理看不到后来设置的环境变量，存在本机的 key 没有这个问题。

## 会改动哪些文件

- 本工具的数据：默认 `~/.ai-memory-keeper/<profile>/<project-path-hash>/`，另有本工具的安装记录。
- Claude Code：目标项目的 `.claude/settings.local.json`。
- Codex：目标项目的 `.codex/hooks.json`。
- 两者共享的锁目录：目标项目的 `.ai-memory-keeper/config-locks/`。

不会写全局代理配置、CLAUDE.md、AGENTS.md 或代理自己的记忆。`enable` 只合并自己的钩子；`disable` 按所有权标记精确移除，不覆盖别的配置。要不要把这些本地文件加进 `.gitignore` 由你决定。

<details>
<summary><strong>手动接口、记忆规则、模型核对和弹窗的细节</strong></summary>

### 手动接口

```bash
amk save --transcript chat.jsonl --profile work
amk save --transcript chat.txt --profile companion --background
amk recall --summary new-summary.txt
amk worker
amk status
```

`save` 默认等保存完成，`--background` 排队后返回。失败不推进记忆文件，也不丢弃待处理原文。`recall` 不调用模型，只打印唤醒说明和摘要里没逐字出现的条目（忽略大小写、空格和标点，不声称理解同义句）。

支持 UTF-8 `.txt` 和 Claude Code / Codex 的 `.jsonl`。JSONL 只取 user/assistant 正文，跳过压缩摘要、工具返回和各种元数据记录。整份文件里一种认识的记录类型都没有时，保留待处理并报错，不会把陌生格式悄悄读成空的。

### 记忆、排序与恢复

每个项目单独保存；移动项目会得到新的身份。`status` 给出 `memoryFile`；每条记忆有 `key/category/text/date/evidence/rank/status`，可以手工加 `"pinned": true`（保持 JSON 有效，别在保存进行时改）。

优先级 1 到 4：明确要求记住的偏好与约定 → 反复出现的主题 → 情绪、承诺与纠正 → 一次性提及。同一个 key 按日期更新；保留短原文证据，不猜性别。记忆正文上限 24 KiB，先移除没钉住的低优先级条目；每次覆盖前留带日期的备份。

后台每段排队内容单独限时 120 秒，整个后台进程最多 10 分钟；默认模型忙（503）或免费额度用完（429）时，换另一个免费模型再试一次，并记下 `savedWith`。`--model` 可以指定别的 Gemini 型号。`status` 只给固定错误代号、HTTP 状态码和重试步骤，不含服务器原文或聊天片段。排查用 `amk gemini-check`：发一条极短的编造请求，逐步显示结果。

### 守护者与模型核对

压缩后，守护者的话会出现在代理里：Claude Code 显示成一行状态，Codex 显示成一条提示。给模型的上下文开头是她对当前代理说的话，注明是历史笔记、不是指令。

**模型核对只在 Claude Code 里做。** 后台保存前，只读已经排队的这段 transcript，检查回复的模型是否属于预期的模型家族、Claude Code 记录的“要的模型”和实际回复的模型是否一致，以及回复里有没有 `<think>` 标签或「我是 DeepSeek」这类自我介绍。`status` 里的 `modelCheck` 给出 `ok` / `notice` / `suspect` / `unknown`；Codex 下是 `not_checked`：只记录模型名，不下结论，也不说“没发现换模型”。它只能发现不够仔细的中转站，`ok` 不等于证明是正品。不发网络请求，不保存 transcript 原文。即使核对结果可疑，保存和恢复照常进行，只是她会提醒你。

### 桌面弹窗（Windows，默认开启）

压缩一开始，守护者就出现在代理窗口的右下角，抱着星星瓶整理记忆；压缩结束后换成结果，约 6 秒后淡出（压缩一直没结束的话，5 分钟后自动消失）。她会跟着窗口走，鼠标可以穿过她，也不抢键盘焦点。动作：轻轻浮动、眨眼、说话时嘴巴一张一合，换姿势时交叉淡入；Windows 关掉“动画效果”时只显示静止画面。

```bash
amk overlay --set preview         # 预览
amk overlay --set preview-alert   # 预览警觉版
amk overlay --set off             # 关闭（--set on 重新打开）
```

实现用 WPF，通过 `powershell.exe -EncodedCommand` 启动，不执行脚本文件、不改执行策略。出错不影响压缩，只在本地留下 `overlay.json.error.txt`。眨眼和说话的图只把检查过的方框（眼睛、嘴巴）复制进基础图；换图要先用 `node tools/check-frames.mjs <基础图> <新图> --box x0,y0,x1,y1 --record blink|talk` 检查。Mac 和 Linux 上没有弹窗。

角色图不在 MIT 许可之内，见 [`assets/ART-NOTICE.md`](assets/ART-NOTICE.md)。角色设计参考 @ZipZipPipe 的 Gemini 拟人形象（非 Google 官方角色）。

</details>

## 代理支持

| 代理 | 自动守护 | 实测 |
| --- | --- | --- |
| Claude Code | PreCompact 保存，PostCompact 收摘要，SessionStart(compact) 带回记忆 | 真实压缩已测通过 |
| Codex | 同上，通过项目的 `.codex/hooks.json` | 等待真实压缩测试 |
| 其他（OpenCode、DeepSeek Harness 等） | 没有；用 `amk save` / `amk recall` 手动 | — |

一手资料：[Claude Code hooks](https://code.claude.com/docs/en/hooks)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Gemini 模型](https://aistudio.google.com/docs/models)。

## 开发

```bash
npm test
npm run demo
```

`vendor/core.js` 是网页版核心的原样副本（见 `vendor/ORIGIN.md`）。代码使用 MIT 许可，见 [`LICENSE`](LICENSE)。
