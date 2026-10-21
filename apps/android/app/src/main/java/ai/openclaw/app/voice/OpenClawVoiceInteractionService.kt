package ai.openclaw.app.voice

import ai.openclaw.app.NodeApp
import ai.openclaw.app.actionAskOpenClaw
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.service.voice.VoiceInteractionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Assistant-role entry point: makes OpenClaw selectable in
 * Settings -> Apps -> Choose default assistant app.
 * Declared with android.permission.BIND_VOICE_INTERACTION.
 *
 * Signatures match the platform jar exactly:
 *   VoiceInteractionService (role hooks) + VoiceInteractionSessionService (session factory)
 * + VoiceInteractionSession (utterance delivery).
 * Hotword detection is platform-owned; the manager hands us a session per trigger and
 * utterances arrive as CommandRequest. Both paths dispatch through the same Gateway node
 * event used by VoiceWakeManager: `voice.transcript` with {eventId, text, sessionKey}.
 */
class OpenClawVoiceInteractionService : VoiceInteractionService() {

  private fun sink(): VoiceCommandSink? = (applicationContext as? NodeApp)?.voiceCommandSinkOrNull()

  override fun onReady() {
    log("assistant role resolved; dispatch path " + if (sink() == null) "unavailable" else "live")
  }

  override fun onGetSupportedVoiceActions(supportedActions: MutableSet<String>): MutableSet<String> = supportedActions

  override fun onShutdown() {
    log("assistant service shutting down")
  }

  private fun log(message: String) {
    android.util.Log.i(TAG, message)
  }

  private companion object {
    const val TAG = "OpenClawAssistant"
  }
}

/** Session factory resolved by VoiceInteractionManagerService via meta-data `session_service`. */
class OpenClawVoiceInteractionSessionService : VoiceInteractionSessionService() {

  override fun onNewSession(extras: Bundle?): VoiceInteractionSession = OpenClawVoiceInteractionSession(this)
}

class OpenClawVoiceInteractionSession(
  factory: VoiceInteractionSessionService,
) : VoiceInteractionSession(factory) {

  private val sink: VoiceCommandSink? = (factory.applicationContext as? NodeApp)?.voiceCommandSinkOrNull()
  private val scope = CoroutineScope(Dispatchers.Default)

  override fun onShow(extras: Bundle?, showFlags: Int) {
    val utterance = extras?.getString(EXTRA_UTTERANCE)
    if (!utterance.isNullOrBlank()) {
      scope.launch { dispatch(utterance) }
    }
  }

  override fun onGetSupportedCommands(commands: Array<String>): BooleanArray =
    BooleanArray(commands.size) { true }

  override fun onRequestCommand(request: VoiceInteractionSession.CommandRequest) {
    val text = request.command?.trim()?.ifEmpty { null }
    if (text == null) {
      request.cancel()
      return
    }
    scope.launch {
      if (dispatch(text)) request.sendResult(Bundle()) else request.cancel()
    }
  }

  override fun onHide() = Unit

  override fun onDestroy() {
    scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    super.onDestroy()
  }

  /** Gateway path first; composer staging when the node is not connected. */
  private suspend fun dispatch(text: String): Boolean {
    val command = stripWakePrefix(text)
    val sink = sink ?: return false.also { openComposer(command) }
    val delivered = sink.sendVoiceCommand(command)
    if (!delivered) openComposer(command)
    return delivered
  }

  private fun openComposer(prompt: String) {
    val intent =
      Intent(actionAskOpenClaw).apply {
        setPackage(context.packageName)
        putExtra("prompt", prompt)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    runCatching { context.startActivity(intent) }
  }

  private fun stripWakePrefix(text: String): String {
    val trigger =
      VoiceWakePreferences
        .defaultTriggerWords
        .firstOrNull { text.lowercase().startsWith(it.lowercase()) }
    if (trigger == null || text.length <= trigger.length) return text
    return text.substring(trigger.length).trimStart { !it.isLetterOrDigit() }.trim().ifEmpty { text }
  }

  private fun log(message: String) {
    android.util.Log.i(TAG, "session ${UUID.randomUUID()}: $message")
  }

  private companion object {
    const val TAG = "OpenClawAssistant"
    const val EXTRA_UTTERANCE = "utterance"
  }
}

/** Indirection so the voice session never touches NodeRuntime private state directly. */
interface VoiceCommandSink {
  suspend fun sendVoiceCommand(text: String): Boolean
}
