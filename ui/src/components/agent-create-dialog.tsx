import { createMemo, createSignal, createUniqueId, Show, untrack } from "solid-js";
import type { AgentsAvatarGenerateResult } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../app/context.ts";
import { Icon } from "../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../components/solid/identity-avatar.tsx";
import { registerAgentCreationEnglish } from "../i18n/locales/en-agent-creation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { t } from "../lib/reactive/i18n.ts";
import { fileToAvatarDataUrl } from "../pages/agents/avatar-image.ts";
import { AvatarPicker, type GeneratedAvatar } from "../pages/agents/avatar-picker.tsx";
import "../styles/agent-create-dialog.css";

registerAgentCreationEnglish();

export type AgentCreateIdentity = { name: string; avatar: string | null };

export function AgentCreateDialog(props: {
  context: ApplicationContext;
  onCancel: () => void;
  onCreate: (identity: AgentCreateIdentity) => void;
}) {
  const [name, setName] = createSignal("");
  const [avatar, setAvatar] = createSignal<string | null>(null);
  const [pickerBusy, setPickerBusy] = createSignal(false);
  const [uploadBusy, setUploadBusy] = createSignal(false);
  const [avatarError, setAvatarError] = createSignal<string | null>(null);
  const draftAgentId = `bot-draft-${createUniqueId()}`;
  const dialogTitle = createMemo(() => t("agentChip.createDialogTitle"));
  const namePlaceholder = createMemo(() => t("agentChip.createDialogName"));
  const draftIdentity = createMemo(() => ({
    id: draftAgentId,
    name: name().trim() || dialogTitle(),
    avatar: avatar() ?? undefined,
  }));
  const mainAgentId = () => props.context.agents.state.agentsList?.defaultId;
  const creatingDisabled = createMemo(() => !name().trim() || pickerBusy() || uploadBusy());

  async function generateAvatar(prompt: string): Promise<GeneratedAvatar> {
    const client = props.context.gateway.snapshot.client;
    const agentId = mainAgentId();
    if (
      !client ||
      !agentId ||
      !canCallGatewayMethod(
        props.context.gateway.snapshot,
        "agents.avatar.generate",
        "operator.admin",
      )
    ) {
      throw new Error(t("agents.identity.avatarPermission"));
    }
    return await client.request<AgentsAvatarGenerateResult>(
      "agents.avatar.generate",
      { agentId, prompt },
      { timeoutMs: 100_000 },
    );
  }

  async function uploadAvatar(file: File) {
    setUploadBusy(true);
    setAvatarError(null);
    try {
      const result = await fileToAvatarDataUrl(file, props.context.config);
      if (!result.ok) {
        throw new Error(
          t(
            result.reason === "too-detailed"
              ? "agents.identity.imageTooDetailed"
              : "agents.identity.imageUnusable",
          ),
        );
      }
      setAvatar(result.dataUrl);
    } catch (error) {
      setAvatarError(formatUiError(error));
    } finally {
      setUploadBusy(false);
    }
  }

  let submitted = false;
  function submit() {
    const identity = untrack(() => ({
      name: name().trim(),
      avatar: avatar(),
      disabled: pickerBusy() || uploadBusy(),
    }));
    if (submitted || !identity.name || identity.disabled) {
      return;
    }
    submitted = true;
    props.onCreate({ name: identity.name, avatar: identity.avatar });
  }

  return (
    <openclaw-modal-dialog label={dialogTitle()} onModal-cancel={() => props.onCancel()}>
      <form
        class="agent-create-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div class="agent-create-dialog__header">
          <h2>{dialogTitle()}</h2>
          <button
            type="button"
            class="agent-create-dialog__close"
            aria-label={t("common.close")}
            onClick={() => props.onCancel()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="agent-create-dialog__body">
          <div class="agent-create-dialog__preview">
            <AgentIdentityAvatar agent={draftIdentity()} />
          </div>
          <label class="agent-create-dialog__name">
            <span class="sr-only">{t("agents.identity.name")}</span>
            <input
              name="name"
              type="text"
              autocomplete="off"
              maxlength="64"
              placeholder={namePlaceholder()}
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              autofocus
            />
          </label>
          <AvatarPicker
            agentId={draftAgentId}
            avatar={avatar()}
            disabled={uploadBusy()}
            onSelect={(nextAvatar) => {
              setAvatar(nextAvatar);
              setAvatarError(null);
            }}
            onUpload={(file) => void uploadAvatar(file)}
            onGenerate={generateAvatar}
            onBusyChange={setPickerBusy}
          />
          <Show when={avatarError()}>
            {(message) => (
              <p class="agent-create-dialog__error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </div>
        <openclaw-modal-actions class="agent-create-dialog__actions">
          <button type="button" class="btn" data-action="cancel" onClick={() => props.onCancel()}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            class="btn primary"
            disabled={creatingDisabled()}
            onClick={() => submit()}
          >
            {t("common.create")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
