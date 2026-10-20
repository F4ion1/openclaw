package ai.openclaw.app.voice

import ai.openclaw.app.NodeApp
import ai.openclaw.app.actionAskOpenClaw
import android.content.Intent
import android.os.Looper
import android.service.voice.AbstractVoiceInteractionSession
import android.service.voice.Extras
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Assistant-role entry point: makes OpenClaw selectable in
 * Settings → Apps → Choose default assistant app and owns hotword + session handling.
 * Declared in AndroidManifest.xml with android.permission.BIND_VOICE_INTERACTION.
 *
 * Utterances flow through the existing Gateway path used by VoiceWakeManager:
 * node event `voice.transcript` with {eventId, text, sessionKey}.
 */
class OpenClawVoiceInteractionService : VoiceInteractionService() {

  override fun onSessionRequested(extras: Extras): VoiceInteractionSession =
    OpenClawVoiceInteractionSession(this, mainLooper)

  private fun commandSink(): VoiceCommandSink? = (applicationContext as? NodeApp)?.voiceCommandSinkOrNull()

  internal fun handleUtterance(text: String) {
    val command = stripWakePrefix(text)
    val sink = commandSink()
    if (sink == null) {
      openComposer(command)
      return
    }
    CoroutineScope(Dispatchers.Default).launch {
      if (!sink.sendVoiceCommand(command)) openComposer(command)
    }
  }

  /** Gateway not connected at speech time — stage the prompt in the composer instead. */
  private fun openComposer(prompt: String) {
    val intent =
      Intent(actionAskOpenClaw).apply {
        setPackage(packageName)
        putExtra("prompt", prompt)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    runCatching { startActivity(intent) }
  }

  private fun stripWakePrefix(text: String): String {
    val trigger =
      VoiceWakePreferences
        .defaultTriggerWords
        .firstOrNull { text.lowercase().startsWith(it.lowercase()) }
    if (trigger == null || text.length <= trigger.length) return text
    return text.substring(trigger.length).trimStart { !it.isLetterOrDigit() }.trim().ifEmpty { text }
  }
}

/** Indirection so the voice session never touches NodeRuntime private state directly. */
interface VoiceCommandSink {
  suspend fun sendVoiceCommand(text: String): Boolean
}

class OpenClawVoiceInteractionSession(
  private val service: VoiceInteractionService,
  looper: Looper,
) : AbstractVoiceInteractionSession(service, looper) {

  private var sessionActive = false

  override fun onHotwordRecognized(extras: Extras): Boolean = sessionActive

  override fun onSessionActivated(utterance: CharSequence?): Boolean {
    sessionActive = true
    val text = utterance?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return false
    service.handleUtterance(text)
    endSession()
    return true
  }

  override fun showSession(): Boolean = true

  override fun hideSession(): Boolean = true

  override fun onSessionClosed() {
    sessionActive = false
  }
}
