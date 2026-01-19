function host() {
  return document.getElementById("toastHost");
}

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

export function toast({ type = "info", title = "", message = "", timeoutMs = 2600 } = {}) {
  const h = host();
  if (!h) return;

  const root = el("div", `toast toast--${type}`);
  const rail = el("div", "toast__rail");

  const body = el("div");
  const t = el("div", "toast__title");
  t.textContent = title || (type === "success" ? "Done" : type === "error" ? "Error" : "Notice");

  const m = el("div", "toast__msg");
  m.textContent = message || "";

  body.appendChild(t);
  body.appendChild(m);

  const close = el("button", "toast__close");
  close.type = "button";
  close.textContent = "×";
  close.onclick = () => {
    root.remove();
  };

  root.appendChild(rail);
  root.appendChild(body);
  root.appendChild(close);

  h.appendChild(root);

  if (timeoutMs > 0) {
    setTimeout(() => {
      // If still present, remove
      if (root.isConnected) root.remove();
    }, timeoutMs);
  }
}

// Convenience helpers
export const toastSuccess = (message, title = "Saved") =>
  toast({ type: "success", title, message });

export const toastError = (message, title = "Something went wrong") =>
  toast({ type: "error", title, message, timeoutMs: 4200 });

export const toastInfo = (message, title = "Info") =>
  toast({ type: "info", title, message });

export const toastWarn = (message, title = "Heads up") =>
  toast({ type: "warn", title, message });
