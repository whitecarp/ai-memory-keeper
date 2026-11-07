---
name: gemini-omni
description: Guides the person step by step to set up a Google Cloud Service Account JSON token and generate AI videos (text-to-video or image-to-video with native audio) using Google Cloud's Gemini Omni (gemini-omni-1.2-flash) via `amk omni`. Activate after deploying AI Memory Keeper, or whenever the person asks about Google Cloud JSON tokens or Gemini Omni video generation.
---

# Guide & Run Google Cloud Gemini Omni (`gemini-omni-1.2-flash`)

AI Memory Keeper shares its encrypted Google Cloud Service Account JSON credential (`amk key --cloud`) with `amk omni`, so the person can use their Google Cloud credits (`$300` free trial or contest coupon) both to keep their AI memories and to generate AI videos with **Google Gemini Omni (`gemini-omni-1.2-flash`)**.

Follow these steps in the person's language:

## 1. Check or Set Up the Google Cloud JSON Token (`JSON 令牌`)

1. Run `amk status` (or `amk.cmd status` on Windows PowerShell) and check `key.cloud.set`.
2. If `key.cloud.set` is `false` (or if the person only has a plain API key instead of a Service Account `.json`), guide them through these 3 short steps in Google Cloud Console:
   - **Step A (Enable API)**: Open [Google Cloud Console](https://console.cloud.google.com/), select the project that holds their Google Cloud credit, and enable the **Vertex AI API** / **Gemini Enterprise Agent Platform API**.
   - **Step B (Create Service Account & Download JSON)**: Go to **IAM & Admin → Service Accounts (IAM 与管理 → 服务账号)** → **Create Service Account**, grant the **Vertex AI User (`roles/aiplatform.user`)** role, open the **Keys (密钥)** tab → **Add Key → Create new key → JSON**, and download the `.json` file to their computer.
   - **Step C (Import into AI Memory Keeper)**:
     - On Windows, run `amk.cmd key --cloud`: a small local window pops up. Tell them to click **选择 JSON 密钥文件… / Pick JSON key file...**, choose their downloaded `.json` file, and click **Save / 保存** (never paste the key into chat).
     - Or let them run `amk.cmd key --cloud --file path\to\service-account.json` in their own terminal.
     - AI Memory Keeper encrypts the JSON credential on this computer (DPAPI on Windows) and exchanges it locally via WebCrypto RS256 JWT (`https://oauth2.googleapis.com/token`) for a short-lived OAuth2 Bearer token whenever needed.

## 2. Guide Them to Generate Video with `Gemini Omni` (`amk omni`)

Once their Google Cloud JSON token is saved, tell them they can generate AI videos right here by telling you what scene they want (and optionally giving a reference start-frame image `.png` / `.jpg`):

- **Text-to-Video**:
  ```bash
  amk omni --prompt "6 seconds, 16:9 anime cinematic shot, ..." --out ./output.mp4
  ```
- **Image-to-Video (from a reference start frame)**:
  ```bash
  amk omni --image ./start-frame.png --prompt "6 seconds, 16:9 anime shot, ..." --out ./output.mp4
  ```
  *(On Windows PowerShell, call `amk.cmd omni ...`)*

## 3. Prompting Best Practices to Share with the Person

When helping the person write or refine their `Gemini Omni` prompt, apply these rules automatically:
1. **Duration & Aspect Ratio**: State the exact duration (`6 seconds`, `8 seconds`, or `10 seconds`) and aspect ratio (`16:9` or `9:16`) in the opening sentence.
2. **Mouth / Lip-Sync Control**:
   - For instrumental or non-speaking shots, explicitly include: `"lips stay gently closed the entire shot (do NOT open mouth or speak)"`.
   - For singing or speaking shots, specify exact second windows: e.g. `"From 0 to 2 seconds lips stay closed; from 2 to 6 seconds she sings naturally into the microphone"`.
3. **Prop & Hand Locking**: Describe left/right hand props in viewer coordinates (`on the viewer's left` / `on the viewer's right`) and forbid morphing extra microphones or duplicate limbs.
