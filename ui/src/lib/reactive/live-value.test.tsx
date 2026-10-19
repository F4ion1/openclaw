import { createSignal, flush, Show, type Setter } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { liveValue } from "./live-value.ts";

it("keeps input selection when a controlled value is already current", () => {
  const [value, setValue] = createSignal("draft");
  const view = mountSolid(() => <textarea ref={liveValue(value)} />);
  const input = view.container.querySelector("textarea")!;
  input.setSelectionRange(2, 2);
  const setter = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
  setValue("draft");
  flush();
  expect(setter).not.toHaveBeenCalled();
  expect(input.selectionStart).toBe(2);
  setValue("replaced");
  flush();
  expect(input.value).toBe("replaced");
  setter.mockRestore();
});

it.each(["initial", "late-value", "late-ref"] as const)(
  "applies prepared values on %s input and keeps equal updates stable",
  (mode) => {
    let publish!: Setter<{ value: string } | undefined>;
    let reveal!: Setter<boolean>;
    const view = mountSolid(() => {
      const [entry, setEntry] = createSignal<{ value: string } | undefined>(
        mode === "late-value" ? undefined : { value: "initial" },
      );
      const [shown, setShown] = createSignal(mode !== "late-ref");
      publish = setEntry;
      reveal = setShown;
      if (mode === "late-ref") {
        const bind = liveValue(() => entry()!.value);
        return <Show when={shown()}>{(_shown) => <input ref={bind} />}</Show>;
      }
      return (
        <Show when={entry()}>{(current) => <input ref={liveValue(() => current().value)} />}</Show>
      );
    });
    if (mode === "initial") {
      expect(view.container.querySelector("input")?.value).toBe("initial");
    } else {
      expect(view.container.querySelector("input")).toBeNull();
    }
    publish({ value: "ready" });
    flush();
    reveal(true);
    flush();
    const input = view.container.querySelector("input")!;
    expect(input.value).toBe("ready");
    input.focus();
    input.setSelectionRange(2, 2);
    publish({ value: "ready" });
    flush();
    expect(view.container.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    publish({ value: "" });
    flush();
    expect(input.value).toBe("");
  },
);
