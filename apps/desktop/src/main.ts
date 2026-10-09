// Glue between the Tauri side and the view. All network and file access happens in Rust.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot } from "./model";
import { installKeys, tick, update, type Actions } from "./view";

const root = document.getElementById("app")!;
let snap = await invoke<Snapshot>("current_state");
let autostart = await invoke<boolean>("autostart_enabled");

const draw = () => update(root, { snap, now: Date.now(), autostart }, act);

const act: Actions = {
  open: (url) => void invoke("open_url", { url }),
  copy: (text) => void navigator.clipboard.writeText(text),
  hide: () => void invoke("hide_popover"),
  setAutostart: (on) =>
    void invoke("set_autostart", { enabled: on })
      .catch(() => undefined)
      .then(async () => {
        autostart = await invoke<boolean>("autostart_enabled");
        draw();
      }),
  quit: () => void invoke("quit"),
};

installKeys(root, act);
draw();
await listen<Snapshot>("snapshot", (e) => {
  snap = e.payload;
  draw();
});
setInterval(() => tick(root, Date.now()), 1000);
