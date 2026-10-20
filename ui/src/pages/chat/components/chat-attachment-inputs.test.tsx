/* @vitest-environment jsdom */

import { onSettled } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";

let host: HTMLDivElement;
let restoreDialog: () => void;

const input = (kind: string, container: Element = host) =>
  container.querySelector<HTMLInputElement>(`.agent-chat__${kind}-input`)!;
const menu = (container: Element = host) =>
  container.querySelector<HTMLButtonElement>(".attachment-menu")!;
const clickSpy = (element: HTMLElement) =>
  vi.spyOn(element, "click").mockImplementation(() => undefined);
function expectRect(element: HTMLElement, ...values: number[]) {
  const properties = ["left", "top", "width", "height"].slice(0, values.length);
  expect(properties.map((key) => element.style.getPropertyValue(key))).toEqual(
    values.map((value) => `${value}px`),
  );
}

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  vi.stubGlobal("isSecureContext", false);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  const camera = host.querySelector("openclaw-chat-camera-capture");
  cleanupSolid();
  host.remove();
  await camera?.updateComplete;
  await Promise.resolve();
  restoreDialog();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountInputs(
  initial: ChatAttachmentControlsProps,
  composerClass?: string,
  inputHandle = createChatAttachmentInputHandle(),
  container = host,
) {
  const view = mountSolid(
    (props: ChatAttachmentControlsProps) => {
      let trigger: HTMLButtonElement | undefined;
      onSettled(() => inputHandle.bindAnchor(trigger));
      return composerClass ? (
        <div class={composerClass}>
          <ChatAttachmentInputs {...props} inputHandle={inputHandle} />
          <button
            ref={(element) => (trigger = element)}
            class="attachment-menu"
            onClick={() => inputHandle.open("camera")}
          >
            Take photo
          </button>
        </div>
      ) : (
        <ChatAttachmentInputs {...props} inputHandle={inputHandle} />
      );
    },
    initial,
    container,
  );
  const camera = container.querySelector("openclaw-chat-camera-capture")!;
  const draw = async (next: ChatAttachmentControlsProps) => {
    view.update(next);
    await camera.updateComplete;
  };
  return { camera, draw };
}

it("retains the camera across input renders and retires its active read scope", async () => {
  const props: ChatAttachmentControlsProps = {
    readSignal: new AbortController().signal,
    onAttachmentsChange: vi.fn(),
  };
  const { draw, camera } = mountInputs(props);
  await camera.updateComplete;
  expect(camera.childElementCount).toBe(0);

  for (const next of [props, { ...props, draft: "A new draft" }]) {
    await draw(next);
    expect(host.querySelector("openclaw-chat-camera-capture")).toBe(camera);
    expect(camera.childElementCount).toBe(0);
  }

  await draw({ ...props, disabled: true });
  expect(camera.disabled).toBe(true);
  camera.show();
  await camera.updateComplete;
  expect(camera.childElementCount).toBe(0);

  const readSignal = new AbortController().signal;
  await draw({ ...props, disabled: true, readSignal });
  expect(camera.readSignal).toBe(readSignal);
  expect(camera.childElementCount).toBe(0);

  await draw({ ...props, disabled: false, readSignal });
  camera.show();
  await camera.updateComplete;
  expect(camera.querySelector("openclaw-modal-dialog")).not.toBeNull();
  await draw({ ...props, readSignal: new AbortController().signal });
  await waitForSolid(() => expect(camera.querySelector("openclaw-modal-dialog")).toBeNull());
});

it.each(
  ["agent-chat__composer-shell", "new-session-page__composer"].flatMap((composerClass) =>
    [false, true].map((android) => ({ composerClass, android })),
  ),
)(
  "keeps native capture scoped to $composerClass with a single-image input (Android: $android)",
  async ({ composerClass, android }) => {
    if (android) {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
      );
    }
    const initialProps = { onAttachmentsChange: vi.fn(), disabled: false };
    const { draw, camera } = mountInputs(initialProps, composerClass);
    const trigger = menu();
    const nativeInput = input("camera");
    const photoInput = input("photo");
    if (!camera || !trigger || !nativeInput || !photoInput) {
      throw new Error("Missing attachment controls");
    }
    expect(nativeInput).toMatchObject({ accept: "image/*", multiple: false });
    expect(nativeInput.getAttribute("capture")).toBe("environment");
    expect(photoInput).toMatchObject({ accept: "image/*", multiple: true });
    expect(photoInput.hasAttribute("capture")).toBe(false);
    expect(input("file").hasAttribute("accept")).toBe(false);
    await camera.updateComplete;
    // A callback retained from the earlier render would now reject this picker.
    initialProps.disabled = true;
    await draw({ ...initialProps, disabled: false });
    const clickNative = clickSpy(nativeInput);
    const rectangle = vi
      .spyOn(trigger, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(12, 24, 36, 48));
    trigger.click();
    await camera.updateComplete;
    if (android) {
      expect(clickNative).toHaveBeenCalledOnce();
      expect(camera.querySelector("openclaw-modal-dialog")).toBeNull();
    } else {
      expect(clickNative).not.toHaveBeenCalled();
      const nativeButton = [...camera.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Use device camera",
      );
      if (!nativeButton) {
        throw new Error("Missing explicit native-camera action");
      }
      rectangle.mockReturnValue(new DOMRect(90, 100, 110, 120));
      nativeButton.click();
      expect(clickNative).toHaveBeenCalledOnce();
      await camera.updateComplete;
    }
    expect(rectangle).toHaveBeenCalledOnce();
    expectRect(nativeInput, android ? 12 : 90, android ? 24 : 100);
    for (const unavailable of [
      { disabled: true },
      { cameraActive: false },
      { readSignal: AbortSignal.abort() },
    ]) {
      await draw({ ...initialProps, disabled: false, ...unavailable });
      trigger.click();
      expect(clickNative).toHaveBeenCalledOnce();
      expect(camera.querySelector("openclaw-modal-dialog")).toBeNull();
    }
  },
);

it("keeps mounted picker refs scoped and refreshes their anchor rectangle on every activation", () => {
  const first = document.createElement("div");
  const second = document.createElement("div");
  host.append(first, second);
  const firstHandle = createChatAttachmentInputHandle();
  const secondHandle = createChatAttachmentInputHandle();
  mountInputs({}, "agent-chat__composer-shell", firstHandle, first);
  mountInputs({}, "new-session-page__composer", secondHandle, second);
  const firstFile = input("file", first);
  const firstPhoto = input("photo", first);
  const secondFile = input("file", second);
  const rectangle = vi
    .spyOn(menu(first), "getBoundingClientRect")
    .mockReturnValue(new DOMRect(12, 24, 36, 48));
  vi.spyOn(menu(second), "getBoundingClientRect").mockReturnValue(new DOMRect(50, 60, 70, 80));
  const clickFirst = clickSpy(firstFile);
  const clickPhoto = clickSpy(firstPhoto);
  const clickSecond = clickSpy(secondFile);

  firstHandle.open("file");
  expect(clickFirst).toHaveBeenCalledOnce();
  expect(clickSecond).not.toHaveBeenCalled();
  expectRect(firstFile, 12, 24, 36, 48);

  rectangle.mockReturnValue(new DOMRect(90, 100, 110, 120));
  firstHandle.openNative("photo");
  expect(clickPhoto).toHaveBeenCalledOnce();
  expectRect(firstPhoto, 90, 100, 110, 120);
  expect(rectangle).toHaveBeenCalledTimes(2);

  secondHandle.open("file");
  expect(clickSecond).toHaveBeenCalledOnce();
  expectRect(secondFile, 50, 60);

  cleanupSolid();
  firstHandle.open("file");
  firstHandle.openNative("photo");
  secondHandle.open("file");
  expect(clickFirst).toHaveBeenCalledOnce();
  expect(clickPhoto).toHaveBeenCalledOnce();
  expect(clickSecond).toHaveBeenCalledOnce();
});
