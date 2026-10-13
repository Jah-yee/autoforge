# Icons

- `source-app.svg`: the app icon master (the ember on a chalk tile). Render it to a 1024px PNG,
  then run `pnpm tauri icon <png> -o src-tauri/icons` to regenerate every bundle size. Delete
  the `android` and `ios` folders it creates.
- `source-tray.svg`: the macOS menu bar icon, a black silhouette rendered to
  `tray-template.png` at 64px. macOS treats it as a template and recolours it for light and dark
  menu bars. Windows and Linux use the full-colour app icon instead.
