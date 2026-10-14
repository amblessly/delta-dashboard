"use strict";

/* onscreen-keyboard.js — touchscreen keyboard for Raspberry Pi kiosk.
   Calls the server to show/hide wvkbd-mobintl when inputs are focused.
   Falls back to a built-in JS keyboard if the server keyboard is unavailable. */

window.OnScreenKeyboard = (function () {

  let activeInput = null;
  let kbVisible = false;
  const API = "/api/keyboard";

  /* ── Server-based matchbox-keyboard ────────────────────────── */
  async function showNative() {
    try {
      await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "show" }),
      });
      kbVisible = true;
    } catch (e) {
      showFallback();
    }
  }

  async function hideNative() {
    try {
      await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "hide" }),
      });
      kbVisible = false;
    } catch (e) {}
  }

  /* ── Fallback JS keyboard ─────────────────────────────────── */
  let overlay = null;
  let capsLock = false;

  const ROWS = [
    ["1","2","3","4","5","6","7","8","9","0"],
    ["q","w","e","r","t","y","u","i","o","p"],
    ["a","s","d","f","g","h","j","k","l"],
    ["z","x","c","v","b","n","m","DEL"],
    ["CAPS","SPACE","DONE"],
  ];
  const CAPS_ROW = [
    ["1","2","3","4","5","6","7","8","9","0"],
    ["Q","W","E","R","T","Y","U","I","O","P"],
    ["A","S","D","F","G","H","J","K","L"],
    ["Z","X","C","V","B","N","M","DEL"],
    ["CAPS","SPACE","DONE"],
  ];

  function createFallback() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "osk-overlay";
    overlay.innerHTML = '<div class="osk-panel" id="oskPanel"></div>';
    document.body.appendChild(overlay);
  }

  function renderFallback() {
    const layout = capsLock ? CAPS_ROW : ROWS;
    const panel = document.getElementById("oskPanel");
    if (!panel) return;
    panel.innerHTML = "";
    for (let r = 0; r < layout.length; r++) {
      const row = document.createElement("div");
      row.className = "osk-row" + (r === layout.length - 1 ? " osk-bottom" : "");
      for (const key of layout[r]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "osk-key";
        btn.textContent = key === "DEL" ? "\u232B" : key === "SPACE" ? "\u2423" : key;
        if (key === "DEL") btn.classList.add("osk-del");
        if (key === "SPACE") btn.classList.add("osk-space");
        if (key === "DONE") { btn.classList.add("osk-done"); btn.textContent = "DONE"; }
        if (key === "CAPS") { btn.classList.add("osk-caps"); btn.textContent = "\u21EA"; }
        btn.addEventListener("touchstart", e => { e.preventDefault(); handleFallbackKey(key); }, { passive: false });
        btn.addEventListener("mousedown", e => { e.preventDefault(); handleFallbackKey(key); });
        row.appendChild(btn);
      }
      panel.appendChild(row);
    }
  }

  function handleFallbackKey(key) {
    if (!activeInput) return;
    if (key === "DEL") {
      activeInput.value = activeInput.value.slice(0, -1);
    } else if (key === "SPACE") {
      activeInput.value += " ";
    } else if (key === "CAPS") {
      capsLock = !capsLock;
      renderFallback();
    } else if (key === "DONE") {
      hideFallback();
      activeInput.blur();
    } else {
      activeInput.value += key;
    }
    activeInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function showFallback() {
    createFallback();
    capsLock = false;
    overlay.style.display = "flex";
    renderFallback();
    kbVisible = true;
  }

  function hideFallback() {
    if (overlay) overlay.style.display = "none";
    kbVisible = false;
  }

  /* ── Show / hide ───────────────────────────────────────────── */
  function show(input) {
    activeInput = input;
    showNative();
  }

  function hide() {
    hideNative();
    if (overlay) overlay.style.display = "none";
    activeInput = null;
    kbVisible = false;
  }

  function init() {
    /* Only enable on touch-capable devices */
    if (!("ontouchstart" in window || navigator.maxTouchPoints > 0)) return;

    document.addEventListener("focusin", e => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        setTimeout(() => show(e.target), 150);
      }
    });

    document.addEventListener("focusout", e => {
      setTimeout(() => {
        if (activeInput && document.activeElement !== activeInput) hide();
      }, 300);
    });
  }

  return { init, show, hide };
})();
