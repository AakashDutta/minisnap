const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const modalState = new WeakMap();

function getFocusableElements(modalEl) {
  return [...modalEl.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hidden && el.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Open a modal dialog, trap Tab/Escape focus inside it, and mark `.app` inert.
 */
export function openModal(modalEl, { initialFocus = null, onCancel = null } = {}) {
  if (!modalEl) return;

  const prevState = modalState.get(modalEl);
  const activeEl = document.activeElement;
  const previousFocus =
    modalEl.classList.contains("open") && prevState
      ? prevState.previousFocus
      : activeEl && typeof activeEl.focus === "function"
        ? activeEl
        : null;

  if (prevState?.keydownHandler) {
    document.removeEventListener("keydown", prevState.keydownHandler);
  }

  modalEl.classList.add("open");

  const appEl = document.querySelector(".app");
  if (appEl) {
    appEl.setAttribute("inert", "");
  }

  const keydownHandler = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (typeof onCancel === "function") {
        onCancel();
      } else {
        closeModal(modalEl);
      }
      return;
    }

    if (event.key === "Tab") {
      const focusables = getFocusableElements(modalEl);
      if (focusables.length === 0) {
        event.preventDefault();
        if (!modalEl.hasAttribute("tabindex")) {
          modalEl.setAttribute("tabindex", "-1");
        }
        modalEl.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === first || !modalEl.contains(document.activeElement)) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !modalEl.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  document.addEventListener("keydown", keydownHandler);
  modalState.set(modalEl, { previousFocus, keydownHandler });

  const focusables = getFocusableElements(modalEl);
  const target =
    initialFocus && typeof initialFocus.focus === "function" && !initialFocus.disabled
      ? initialFocus
      : focusables[0];

  if (target) {
    target.focus();
  } else {
    if (!modalEl.hasAttribute("tabindex")) {
      modalEl.setAttribute("tabindex", "-1");
    }
    modalEl.focus();
  }
}

/**
 * Close a modal dialog, release `.app` inert when none remain open, and restore focus.
 */
export function closeModal(modalEl) {
  if (!modalEl) return;

  modalEl.classList.remove("open");

  const state = modalState.get(modalEl);
  if (state?.keydownHandler) {
    document.removeEventListener("keydown", state.keydownHandler);
  }
  modalState.delete(modalEl);

  if (document.querySelectorAll(".modal-backdrop.open").length === 0) {
    const appEl = document.querySelector(".app");
    if (appEl) {
      appEl.removeAttribute("inert");
    }
  }

  if (
    state?.previousFocus &&
    state.previousFocus.isConnected &&
    typeof state.previousFocus.focus === "function"
  ) {
    state.previousFocus.focus();
  }
}
