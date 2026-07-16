# 🌿 Pagetree

A tiny, offline-first workspace. Pages inside pages, infinitely.

- **Pages nest infinitely** — every page can hold sub-pages (page inside page inside page)
- **Blocks**: rich text (bold, strikethrough, colors, bullet & numbered lists), checklists, tables, images
- **✅ Tasks view**: every checkbox from every page in one place — grouped by project, or in your own manual order (drag or ▲▼), each labeled with its root project › page
- **🗺️ Mindmap view**: left-to-right tree of your workspace — projects as roots, sub-pages branch right. Create and rename nodes on the map, then click any node to open it and write inside. On phones: Fit-to-screen, pinch or buttons to zoom.
- **100% local**: all data lives in your browser (IndexedDB). No server, no account, works fully offline once installed.

Total size: ~60 KB. No frameworks, no build step, no dependencies.

## Host it on GitHub Pages (one time, free)

1. Create a new repository on github.com (e.g. `pagetree`), can be public or private*.
2. Upload all the files in this folder (keep the `icons/` folder as-is). Easiest way: on the repo page click **Add file → Upload files**, drag everything in, commit.
3. Go to **Settings → Pages** → under "Build and deployment", set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
4. Wait ~1 minute. Your app is live at `https://YOUR-USERNAME.github.io/pagetree/`

*Private repos need GitHub Pro for Pages; a public repo is fine — the app contains no data, your data never leaves your phone.

## Install on your Android phone

1. Open the URL in **Chrome**.
2. Tap the **⋮ menu → Add to Home screen** (or the "Install app" banner).
3. Done. It opens full-screen like a native app and **works with Wi-Fi off**.

## Notes

- Your data is stored per-device, per-browser. Clearing the browser's site data deletes it.
- If you later update the code on GitHub, the app picks up the new version on the next visit with internet (bump `pagetree-v5` in `sw.js` to force it).
