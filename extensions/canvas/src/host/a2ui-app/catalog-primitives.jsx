import { onSettled } from "solid-js";

/** Both dialects keep their catalog markup; the native dialog owns focus and dismissal. */
export function CatalogDialog(props) {
  let dialog;
  onSettled(() => () => {
    if (dialog.open) {
      dialog.close();
    }
  });
  return (
    <>
      <div class={props.triggerClass} onClick={() => dialog.showModal()}>
        {props.trigger}
      </div>
      <dialog
        class={props.class}
        ref={(element) => {
          dialog = element;
        }}
        onClick={(event) => {
          if (event.target === dialog) {
            dialog.close();
          }
        }}
      >
        {props.children(() => dialog.close())}
      </dialog>
    </>
  );
}
