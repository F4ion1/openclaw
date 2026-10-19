import { createEffect } from "@solidjs/signals";

/** Apply prepared owner values without rewriting an equal native value or selection. */
export function liveValue<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  value: () => string,
  onValueChange?: (field: T) => void,
) {
  let field: T | undefined;
  let preparedValue: string | undefined;
  const writeValue = (next: string) => {
    if (field && field.value !== next) {
      field.value = next;
      onValueChange?.(field);
    }
  };
  createEffect(value, (next) => {
    preparedValue = next;
    writeValue(next);
  });
  return (element: T) => {
    field = element;
    // Refs run unowned and can precede the frame that first mounts a conditional field.
    if (preparedValue !== undefined) {
      writeValue(preparedValue);
    }
  };
}
