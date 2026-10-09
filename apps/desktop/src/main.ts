// Glue between the Tauri side and the view. All network and file access happens in Rust.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot } from "./model";
import { installKeys, tick, update, type Actions } from "./view";

const root = document.getElementById("app")!;
let snap: Snapshot = {
  state: { kind: "unreachable", reason: "The app could not read its state." },
  lastOkAt: null,
};
let autostart = false;

const draw = () => update(root, { snap, now: Date.now(), autostart }, act);
const quiet = () => undefined;

const act: Actions = {
  open: (url) => void invoke("open_url", { url }).catch(quiet),
  copy: (text) => void navigator.clipboard.writeText(text).catch(quiet),
  hide: () => void invoke("hide_popover").catch(quiet),
  // Whatever happens, show the value the OS reports (or the previous one if it cannot be read).
  setAutostart: (on) =>
    void invoke("set_autostart", { enabled: on })
      .catch(quiet)
      .then(() => invoke<boolean>("autostart_enabled"))
      .then((v) => {
        autostart = v;
      }, quiet)
      .then(draw),
  quit: () => void invoke("quit").catch(quiet),
};

installKeys(root, act);
draw();
let gotEvent = false;
// Listen first so a snapshot emitted while current_state is in flight is not lost.
await listen<Snapshot>("snapshot", (e) => {
  gotEvent = true;
  snap = e.payload;
  draw();
}).catch(quiet);
const initial = await invoke<Snapshot>("current_state").catch(() => null);
if (initial && !gotEvent) snap = initial;
autostart = await invoke<boolean>("autostart_enabled").catch(() => false);
draw();
setInterval(() => tick(root, Date.now()), 1000);
