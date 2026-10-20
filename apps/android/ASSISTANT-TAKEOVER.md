# OpenClaw Android — Google Assistant takeover (fork build)

Goal: make Cypher the system digital assistant on Vern's phone (Stage 3 of the paused plan; Stages 1–2 already shipped upstream).

## Why a fork is mandatory
- Fork builds need **your own Android signing key** — the official OpenClaw release key is not in the repo (`apps/android` README confirms; debug builds get an auto-generated debug key).
- Play vs sideload use different signing identities; switching channels requires uninstall/reinstall (local app data loss). Stay on the sideload/fork channel once built.

## Runtime shape (matches upstream design)
- Phone is a **companion node**; the Gateway stays on cypherarm. The assistant service does not run its own LLM — it forwards utterances as `voice.transcript` node events (`{eventId, text, sessionKey}`) exactly like `VoiceWakeManager.sendVoiceWakeCommand` in `NodeRuntime.kt` (line ~5501).
- Trigger words remain user-configurable (default `openclaw`, `claude`, `computer`) via `VoiceWakePreferences`.

## Patch notes
1. **NodeApp accessor** — add:
   ```kotlin
   fun voiceCommandSinkOrNull(): VoiceCommandSink? = runtimeInstance?.asVoiceCommandSink()
   ```
   and on `NodeRuntime`:
   ```kotlin
   fun asVoiceCommandSink(): VoiceCommandSink =
     VoiceCommandSink { text -> sendVoiceWakeCommand(VoiceWakeMatch(trigger = "", command = text)) }
   ```
2. **Manifest** — add the `BIND_VOICE_INTERACTION` service block (see `scaffold/manifest-patch.xml`).
3. **Session service** — drop `scaffold/OpenClawVoiceInteractionService.kt` into `app/src/main/java/ai/openclaw/app/voice/`.

## Build steps
1. Fork `openclaw/openclaw` → `vern-openclaw` (blocked until GitHub identity is connected for this agent).
2. Generate a signing key:
   ```bash
   keytool -genkey -v -keystore openclaw-fork.keystore -alias openclaw-fork -keyalg RSA -keysize 2048 -validity 10000
   ```
3. In `apps/android`, set `signingConfigs.release` to the fork keystore (local `gradle.properties`, never committed), then:
   ```bash
   ./gradlew :app:assembleRelease
   ```
4. Install over ADB/Tailscale; pair as node; approve `openclaw devices approve`.
5. Settings → Apps → Choose default assistant app → pick the fork build.

## Honest limits (Android, not OpenClaw)
- Always-on hotword ("Hey Google"-style) is only honored for the *selected* assistant and is region/OEM-dependent; on many phones the fork gets long-press-home/A-assist-key sessions but **not** background hotword.
- Background mic without UI is heavily restricted (Android 13+); background hotword via `VoiceInteractionService` is the only sanctioned path, and third-party support varies. The existing foreground `VoiceWakeManager` is the reliable fallback while the app is open.
- A fork can't be updated from Play; re-sideload on each upstream merge.

## Status
- Stage 1 (ASSIST picker entry): shipped upstream ✔
- Stage 2 (App Actions): shipped upstream ✔
- Stage 3 (VoiceInteractionService): scaffold authored here; fork + build pending GitHub identity + signing key.
