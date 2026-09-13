// One queue per region. Native controls stay enabled while the model works.
(() => {
  const config = JSON.parse(
    document.getElementById("harness-region").textContent,
  );
  const root = document.getElementById("region-root");
  const style = document.getElementById("region-style");
  let state = config.state,
    revision = config.revision,
    active = null,
    failed = null;
  const callbacks = new Set(),
    timers = new Map(),
    queue = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const send = (type, data = {}) =>
    parent.postMessage(
      { type, visitId: config.visitId, id: config.id, revision, ...data },
      "*",
    );
  const controls = () => [
    ...root.querySelectorAll(
      "input[name],select[name],textarea[name],button[name]",
    ),
  ];
  const keyedControls = () => {
    const counts = new Map();
    return controls().map((control) => {
      const index = counts.get(control.name) || 0;
      counts.set(control.name, index + 1);
      return [`${control.name}\u0000${index}`, control];
    });
  };
  const controlValue = (control) => {
    if (["checkbox", "radio"].includes(control.type)) return control.checked;
    if (control.multiple && control.options)
      return [...control.selectedOptions].map((o) => o.value);
    return control.value;
  };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const snapshot = () =>
    new Map(
      keyedControls().map(([key, control]) => [key, controlValue(control)]),
    );
  const collect = (submitter) => {
    const groups = new Map();
    for (const control of controls()) {
      if (
        control.matches(":disabled") ||
        !control.name ||
        control.type === "file"
      )
        continue;
      if (
        (control.tagName === "BUTTON" ||
          ["button", "submit", "reset", "image"].includes(control.type)) &&
        control !== submitter
      )
        continue;
      if (["checkbox", "radio"].includes(control.type) && !control.checked)
        continue;
      const values =
        control.multiple && control.options
          ? [...control.selectedOptions]
              .filter((o) => !o.disabled)
              .map((o) => o.value)
          : [control.value];
      if (!groups.has(control.name)) groups.set(control.name, []);
      groups.get(control.name).push(...values);
    }
    return Object.fromEntries(
      [...groups]
        .filter(([, values]) => values.length)
        .map(([key, values]) => [
          key,
          values.length === 1 ? values[0] : values,
        ]),
    );
  };
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.hidden = true;
  status.style.cssText =
    "font:14px system-ui;color:#b42318;padding:8px;margin:0";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  document.body.append(status);
  const resize = () =>
    send("region:resize", {
      height:
        Math.max(
          root.getBoundingClientRect().bottom,
          status.hidden ? 0 : status.getBoundingClientRect().bottom,
        ) + 1,
    });
  const notify = () => {
    for (const callback of callbacks) {
      try {
        callback(state);
      } catch (error) {
        console.error("Region callback failed", error);
      }
    }
  };
  const drain = () => {
    if (active || !queue.length) return;
    const item = queue.shift();
    active = { item, values: snapshot(), state: clone(state) };
    failed = null;
    status.hidden = true;
    root.setAttribute("aria-busy", "true");
    const inputs = item.native ? collect() : item.inputs;
    if (item.native)
      for (const [name, value] of Object.entries(item.submitter))
        inputs[name] = Object.hasOwn(inputs, name)
          ? [].concat(inputs[name], value)
          : value;
    send("region:event", {
      event: { action: item.action, inputs, state: active.state },
    });
  };
  const enqueue = (
    action,
    inputs,
    kind = "explicit",
    native = false,
    submitter = {},
  ) => {
    if (!action) return;
    const item = { action, inputs: clone(inputs), kind, native, submitter };
    // Coalesce only adjacent input events for the same action, never clicks.
    if (
      kind === "input" &&
      queue.at(-1)?.kind === kind &&
      queue.at(-1)?.action === action
    )
      queue[queue.length - 1] = item;
    else queue.push(item);
    drain();
  };
  const cancelTimers = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
  globalThis.region = {
    get root() {
      return root;
    },
    get state() {
      return state;
    },
    setState(next) {
      state = clone(next ?? {});
    },
    dispatch(action, inputs) {
      enqueue(action, inputs ?? collect());
    },
    onUpdate(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  };
  const onInput = (event) => {
    const control = event.target.closest("[data-region-action]");
    if (!control?.dataset.regionEvent?.split(/[ ,]+/).includes(event.type))
      return;
    clearTimeout(timers.get(control));
    const action = control.dataset.regionAction;
    timers.set(
      control,
      setTimeout(() => {
        timers.delete(control);
        if (
          [...root.querySelectorAll("[data-region-action]")].some(
            (node) => node.dataset.regionAction === action,
          )
        )
          enqueue(action, {}, "input", true);
      }, 300),
    );
  };
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("click", (event) => {
    const target = event.target.closest(
      "button,a,input[type=button],input[type=submit],[role=button]",
    );
    if (!target || target.matches(":disabled")) return;
    const action = target.dataset.regionAction;
    const submits =
      target.form &&
      (target.type === "submit" ||
        (target.tagName === "BUTTON" && !target.hasAttribute("type")));
    if (action && !submits) {
      event.preventDefault();
      cancelTimers();
      enqueue(
        action,
        {},
        "explicit",
        true,
        target.name ? { [target.name]: target.value } : {},
      );
    } else if (target.tagName === "A") {
      const href = target.getAttribute("href");
      if (href?.startsWith("/") && !href.startsWith("//")) {
        event.preventDefault();
        send("region:navigate", { path: href });
      }
    }
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    cancelTimers();
    enqueue(
      event.submitter?.dataset.regionAction ||
        event.target.dataset.regionAction,
      {},
      "explicit",
      true,
      event.submitter?.name
        ? { [event.submitter.name]: event.submitter.value }
        : {},
    );
  });
  retry.onclick = () => {
    if (failed)
      enqueue(
        failed.action,
        failed.inputs,
        failed.kind,
        failed.native,
        failed.submitter,
      );
  };
  window.addEventListener("message", (message) => {
    const data = message.data;
    if (
      message.source !== parent ||
      data?.visitId !== config.visitId ||
      data?.id !== config.id
    )
      return;
    if (data.type === "region:error") {
      if (data.operation === "interaction") {
        failed = active?.item;
        active = null;
        queue.length = 0;
        root.removeAttribute("aria-busy");
      }
      status.textContent = data.message || "Interaction failed.";
      if (failed) status.append(" ", retry);
      status.hidden = false;
      resize();
      return;
    }
    if (
      data.type !== "region:update" ||
      !active ||
      data.revision !== revision + 1
    )
      return;
    const sent = active,
      before = snapshot();
    const focus = keyedControls().find(
      ([, control]) => control === document.activeElement,
    );
    const selection =
      focus && typeof focus[1].selectionStart === "number"
        ? [focus[1].selectionStart, focus[1].selectionEnd]
        : null;
    revision = data.revision;
    style.textContent = data.css ?? "";
    root.innerHTML = data.html;
    for (const [key, control] of keyedControls()) {
      const value = before.get(key);
      if (!before.has(key) || equal(value, sent.values.get(key))) continue;
      if (["checkbox", "radio"].includes(control.type)) control.checked = value;
      else if (control.multiple && control.options)
        for (const option of control.options)
          option.selected = value.includes(option.value);
      else control.value = value;
    }
    // Local code may advance while inference runs. Preserve fields it changed
    // after dispatch while applying the model's other state fields.
    const next = { ...data.state };
    for (const key of new Set([
      ...Object.keys(sent.state),
      ...Object.keys(state),
    ])) {
      if (equal(sent.state[key], state[key])) continue;
      if (Object.hasOwn(state, key)) next[key] = state[key];
      else delete next[key];
    }
    state = next;
    if (focus) {
      const replacement = keyedControls().find(
        ([key]) => key === focus[0],
      )?.[1];
      replacement?.focus();
      if (selection && typeof replacement?.selectionStart === "number")
        replacement.setSelectionRange(...selection);
    }
    active = null;
    root.removeAttribute("aria-busy");
    status.hidden = true;
    notify();
    resize();
    drain();
  });
  if ("ResizeObserver" in globalThis) new ResizeObserver(resize).observe(root);
  resize();
})();
