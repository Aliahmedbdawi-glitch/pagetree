/* ================= Pagetree ================= */
"use strict";

/* ---------- state ---------- */
let ws = null;               // workspace {version, pages:[], taskOrder:[], expanded:{}}
let currentPageId = null;    // page open in main view
let view = "page";           // "page" | "tasks" | "map"
let tasksMode = "grouped";   // "grouped" | "flat"
let mapRenameId = null;      // page id being renamed on the mindmap
let mapScopeId = null;       // null = all projects; page id = that page + descendants
let mapZoomAuto = true;      // true = scale to fit viewport
let mapScale = 1;            // manual zoom level (1 = natural size)
let mapLayout = null;        // last layout metrics for zoom handlers
let editKey = null;          // active typing session (one undo step per focus)
let selectedBlockId = null;  // block targeted by doc toolbar actions
let sb = null;               // Supabase client
let session = null;          // active auth session
let cloudReady = false;      // schema reachable + logged in
let cloudSaveTimer = null;
let localUpdatedAt = 0;
let appUserId = null;
let appStarting = null;      // in-flight startApp promise (single-flight)
let preferOffline = false;   // user chose Continue offline — ignore cloud auth until they sign in

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function newPage(title, icon) {
  return { id: uid(), icon: icon || "📄", title: title || "Untitled", blocks: [], children: [] };
}
function defaultWorkspace() {
  const p = newPage("My first project", "📁");
  p.blocks.push({ id: uid(), type: "text", html: "Welcome to <b>Pagetree</b>. Click anywhere and start writing. Use ＋ in the sidebar to nest pages inside pages, infinitely." });
  p.blocks.push({ id: uid(), type: "checklist", items: [
    { id: uid(), text: "Create a sub-page", done: false },
    { id: uid(), text: "Add a task — then find it in ✅ Tasks", done: false },
  ]});
  return { version: 1, pages: [p], taskOrder: [], expanded: {} };
}

function normalizePage(page) {
  if (!page || typeof page !== "object") return;
  if (!Array.isArray(page.children)) page.children = [];
  if (!Array.isArray(page.blocks)) page.blocks = [];
  if (!page.id) page.id = uid();
  if (page.title == null) page.title = "Untitled";
  if (page.icon == null) page.icon = "📄";
  for (const child of page.children) normalizePage(child);
}

function normalizeWorkspace(data) {
  if (!data || typeof data !== "object") return defaultWorkspace();
  if (!Array.isArray(data.pages)) data.pages = [];
  data.expanded = data.expanded || {};
  data.taskOrder = data.taskOrder || [];
  for (const p of data.pages) normalizePage(p);
  return data;
}

/* ---------- local + cloud storage ---------- */
const DB = "pagetree", STORE = "kv";
const LOCAL_META_KEY = "workspace_meta";

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function idbPut(key, value) {
  const db = await idb();
  db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
}
async function loadLocalBundle() {
  const data = await idbGet("workspace");
  const meta = await idbGet(LOCAL_META_KEY);
  return {
    ws: data ? normalizeWorkspace(data) : null,
    updatedAt: meta?.updatedAt || 0,
  };
}
async function loadWS() {
  const { ws } = await loadLocalBundle();
  return ws;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    localUpdatedAt = Date.now();
    try {
      await idbPut("workspace", ws);
      await idbPut(LOCAL_META_KEY, { updatedAt: localUpdatedAt });
    } catch (e) { console.error("local save failed", e); }
    queueCloudSave();
  }, 250);
}

function initSupabase() {
  const cfg = window.PAGETREE_SUPABASE;
  if (!cfg?.url || !cfg?.key || !window.supabase?.createClient) return null;
  try {
    return window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  } catch (e) {
    console.error("Supabase init failed", e);
    return null;
  }
}
async function cloudFetchWorkspace(userId) {
  const { data, error } = await sb.from("workspaces")
    .select("data, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ws: normalizeWorkspace(data.data),
    updatedAt: new Date(data.updated_at).getTime(),
  };
}
async function cloudPushWorkspace(userId, workspace) {
  const payload = {
    user_id: userId,
    data: workspace,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("workspaces").upsert(payload, { onConflict: "user_id" });
  if (error) throw error;
}
function queueCloudSave() {
  if (!cloudReady || !session?.user?.id) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(async () => {
    setSyncBadge("syncing");
    try {
      await cloudPushWorkspace(session.user.id, ws);
      setSyncBadge("synced");
    } catch (e) {
      console.error("cloud save failed", e);
      setSyncBadge("offline");
    }
  }, 600);
}
async function resolveWorkspace(userId) {
  let local = { ws: null, updatedAt: 0 };
  try {
    local = await Promise.race([
      loadLocalBundle(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Local storage timed out")), 5000)),
    ]);
  } catch (e) {
    console.warn("local load failed", e);
  }
  let cloud = null;
  try {
    cloud = await Promise.race([
      cloudFetchWorkspace(userId),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Cloud timed out")), 10000)),
    ]);
    cloudReady = true;
  } catch (e) {
    console.warn("cloud load failed", e);
    cloudReady = false;
    setSyncBadge("offline");
    return local.ws || defaultWorkspace();
  }
  if (cloud && local.ws) {
    if (cloud.updatedAt >= local.updatedAt) {
      localUpdatedAt = cloud.updatedAt;
      await idbPut("workspace", cloud.ws);
      await idbPut(LOCAL_META_KEY, { updatedAt: cloud.updatedAt });
      return cloud.ws;
    }
    queueCloudSave();
    return local.ws;
  }
  if (cloud) {
    localUpdatedAt = cloud.updatedAt;
    await idbPut("workspace", cloud.ws);
    await idbPut(LOCAL_META_KEY, { updatedAt: cloud.updatedAt });
    return cloud.ws;
  }
  if (local.ws) {
    queueCloudSave();
    return local.ws;
  }
  return defaultWorkspace();
}
function setSyncBadge(state) {
  const badge = $("#syncBadge");
  if (!badge) return;
  if (!cloudReady) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.className = "syncbadge " + state;
  badge.textContent = state === "syncing" ? "Syncing…" : state === "synced" ? "Synced" : "Offline";
}
function updateAccountButton() {
  const btn = $("#navAccount");
  if (!btn) return;
  if (session?.user) {
    btn.hidden = false;
    const email = session.user.email || "Account";
    btn.textContent = email.split("@")[0];
    btn.title = email + " — click to sign out";
  } else {
    btn.hidden = true;
  }
}
function showAuthGate(msg) {
  const gate = $("#authGate");
  if (!gate) return;
  gate.hidden = false;
  gate.innerHTML = "";
  const card = el("div", "authcard");
  card.append(el("h2", null, "Sign in to Pagetree"));
  card.append(el("p", "authsub", "Your pages sync across devices."));
  const form = el("form", "authform");
  const email = el("input", "authinput");
  email.type = "email"; email.placeholder = "Email"; email.required = true; email.autocomplete = "email";
  const pass = el("input", "authinput");
  pass.type = "password"; pass.placeholder = "Password"; pass.required = true; pass.minLength = 6;
  pass.autocomplete = "current-password";
  const err = el("p", "autherr");
  if (msg) {
    err.textContent = msg;
    err.hidden = false;
    if (/loading/i.test(msg)) err.classList.add("ok");
  } else err.hidden = true;
  const readCreds = () => {
    const em = email.value.trim();
    const pw = pass.value;
    if (!em) throw new Error("Enter your email address.");
    if (!pw || pw.length < 6) throw new Error("Password must be at least 6 characters.");
    return { email: em, password: pw };
  };
  const authErr = ex => {
    if (ex?.message?.includes("Anonymous sign-ins")) {
      return "Enter a valid email and password (6+ characters).";
    }
    if (ex?.message?.includes("email_provider_disabled") || ex?.code === "email_provider_disabled") {
      return "Email sign-in is disabled in Supabase. Enable Email under Auth → Providers.";
    }
    return ex?.message || "Request failed";
  };
  const actions = el("div", "authactions");
  const signIn = el("button", "authbtn primary", "Sign in");
  signIn.type = "submit";
  const signUp = el("button", "authbtn", "Create account");
  signUp.type = "button";
  const offline = el("button", "authbtn", "Continue offline");
  offline.type = "button";
  offline.title = "Use this device only — no cloud sync";
  actions.append(signIn, signUp);
  form.append(email, pass, err, actions);
  offline.onclick = () => startOfflineApp();
  form.onsubmit = async e => {
    e.preventDefault();
    err.hidden = true;
    signIn.disabled = signUp.disabled = true;
    try {
      const creds = readCreds();
      const { error } = await sb.auth.signInWithPassword(creds);
      if (error) throw error;
    } catch (ex) {
      err.textContent = authErr(ex);
      err.hidden = false;
      err.classList.remove("ok");
    } finally {
      signIn.disabled = signUp.disabled = false;
    }
  };
  signUp.onclick = async () => {
    err.hidden = true;
    signIn.disabled = signUp.disabled = true;
    try {
      const creds = readCreds();
      const { error } = await sb.auth.signUp(creds);
      if (error) throw error;
      err.textContent = "Account created. Check your email if confirmation is required, then sign in.";
      err.hidden = false;
      err.classList.add("ok");
    } catch (ex) {
      err.textContent = authErr(ex);
      err.hidden = false;
      err.classList.remove("ok");
    } finally {
      signIn.disabled = signUp.disabled = false;
    }
  };
  card.append(form);
  card.append(offline);
  gate.append(card);
}
function hideAuthGate() {
  const gate = $("#authGate");
  if (gate) { gate.hidden = true; gate.innerHTML = ""; }
}
function showAppFromWorkspace(workspace) {
  ws = normalizeWorkspace(workspace);
  currentPageId = ws.pages[0]?.id || null;
  hideAuthGate();
  updateAccountButton();
  render();
  updateUndoButtons();
}
async function startOfflineApp() {
  preferOffline = true;
  session = null;
  appUserId = null;
  cloudReady = false;
  appStarting = null;
  hideAuthGate();
  try {
    ws = normalizeWorkspace((await loadWS()) || defaultWorkspace());
  } catch {
    ws = defaultWorkspace();
  }
  currentPageId = ws.pages[0]?.id || null;
  updateAccountButton();
  setSyncBadge("offline");
  render();
  updateUndoButtons();
  // Clear persisted session so TOKEN_REFRESHED / reload don't pull us back into Loading.
  if (sb) {
    try { await sb.auth.signOut({ scope: "local" }); } catch (_) {}
  }
}
async function startApp() {
  if (preferOffline) return;
  const userId = session?.user?.id;
  if (!userId) {
    showAuthGate("Session expired. Sign in again.");
    return;
  }
  if (appUserId === userId && ws) {
    hideAuthGate();
    updateAccountButton();
    setSyncBadge(cloudReady ? "synced" : "offline");
    render();
    return;
  }
  // Avoid rebuilding the gate / re-fetching when getSession + onAuthStateChange both fire.
  if (appStarting) return appStarting;

  appStarting = (async () => {
    appUserId = userId;
    try {
      // Local-first: open the app immediately on refresh. Never flash the sign-in form.
      let local = { ws: null, updatedAt: 0 };
      try {
        local = await Promise.race([
          loadLocalBundle(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Local storage timed out")), 3000)),
        ]);
      } catch (e) {
        console.warn("local load failed", e);
      }
      if (preferOffline) return;

      if (local.ws) {
        localUpdatedAt = local.updatedAt || 0;
        showAppFromWorkspace(local.ws);
        setSyncBadge("syncing");
      } else {
        // No local cache yet — open immediately; cloud fills in when ready.
        showAppFromWorkspace(defaultWorkspace());
        setSyncBadge("syncing");
      }

      // Cloud sync in the background.
      try {
        const cloud = await Promise.race([
          cloudFetchWorkspace(userId),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Cloud timed out")), 10000)),
        ]);
        cloudReady = true;
        if (preferOffline) return;
        if (cloud) {
          if (!local.ws || cloud.updatedAt >= (local.updatedAt || 0)) {
            localUpdatedAt = cloud.updatedAt;
            await idbPut("workspace", cloud.ws);
            await idbPut(LOCAL_META_KEY, { updatedAt: cloud.updatedAt });
            showAppFromWorkspace(cloud.ws);
          } else {
            queueCloudSave();
          }
        } else if (local.ws) {
          queueCloudSave();
        } else {
          // Keep the default workspace we already showed; push it up.
          queueCloudSave();
        }
        setSyncBadge("synced");
      } catch (e) {
        console.warn("cloud load failed", e);
        cloudReady = false;
        setSyncBadge("offline");
      }
      updateAccountButton();
    } catch (e) {
      console.error("startApp failed", e);
      appUserId = null;
      if (!preferOffline) {
        showAuthGate(e.message || "Could not load workspace. Try again or continue offline.");
      }
    } finally {
      appStarting = null;
    }
  })();
  return appStarting;
}
async function handleSignedOut() {
  if (preferOffline) return;
  session = null;
  appUserId = null;
  cloudReady = false;
  appStarting = null;
  ws = null;
  $("#main").innerHTML = "";
  updateAccountButton();
  setSyncBadge("offline");
  showAuthGate();
}

/* ---------- undo / redo ---------- */
const MAX_UNDO = 40;
let undoStack = [];
let redoStack = [];
let restoring = false;

function snapshot() {
  return JSON.stringify({ ws, currentPageId, view, tasksMode, mapRenameId, mapZoomAuto, mapScale });
}
function restoreSnapshot(json) {
  const s = JSON.parse(json);
  ws = s.ws;
  currentPageId = s.currentPageId;
  view = s.view;
  tasksMode = s.tasksMode;
  mapRenameId = s.mapRenameId;
  mapZoomAuto = s.mapZoomAuto ?? true;
  mapScale = s.mapScale ?? 1;
}
function updateUndoButtons() {
  const u = $("#navUndo"), r = $("#navRedo");
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}
function pushUndo() {
  if (restoring) return;
  const snap = snapshot();
  if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}
function undo() {
  if (!undoStack.length) return;
  restoring = true;
  endEdit();
  redoStack.push(snapshot());
  restoreSnapshot(undoStack.pop());
  save();
  render();
  updateUndoButtons();
  restoring = false;
}
function redo() {
  if (!redoStack.length) return;
  restoring = true;
  endEdit();
  undoStack.push(snapshot());
  restoreSnapshot(redoStack.pop());
  save();
  render();
  updateUndoButtons();
  restoring = false;
}
function record(fn, { refresh = "full" } = {}) {
  pushUndo();
  fn();
  save();
  if (refresh === "full") render();
  else if (refresh === "tree") renderTree();
}
function startEdit(key) {
  if (editKey !== key) {
    pushUndo();
    editKey = key;
  }
}
function endEdit() {
  editKey = null;
}
function activeTextBlock() {
  const el = document.activeElement?.closest?.(".textblock");
  if (!el || !currentPageId) return null;
  const hit = findPage(currentPageId);
  if (!hit) return null;
  const block = hit.page.blocks.find(b => b.id === el.dataset.blk);
  return block ? { el, block, page: hit.page } : null;
}
function applyFormat(fn) {
  const hit = activeTextBlock();
  if (!hit) return;
  pushUndo();
  fn();
  hit.block.html = hit.el.innerHTML;
  save();
}

/* ---------- tree helpers ---------- */
function walk(pages, fn, path = []) {
  for (const p of pages) {
    if (fn(p, path) === false) return false;
    if (walk(p.children, fn, path.concat(p)) === false) return false;
  }
  return true;
}
function findPage(id) {
  let hit = null;
  walk(ws.pages, (p, path) => { if (p.id === id) { hit = { page: p, path }; return false; } });
  return hit;
}
function findParentList(id) {
  if (ws.pages.some(p => p.id === id)) return ws.pages;
  let list = null;
  walk(ws.pages, (p) => { if (p.children.some(c => c.id === id)) { list = p.children; return false; } });
  return list;
}

function removePageLinksTo(pageId) {
  walk(ws.pages, (p) => {
    p.blocks = p.blocks.filter(b => !(b.type === "page" && b.pageId === pageId));
  });
}

function collectSubtreeIds(page) {
  const ids = [page.id];
  for (const child of page.children) ids.push(...collectSubtreeIds(child));
  return ids;
}

function countSubtreePages(page) {
  let n = 1;
  for (const child of page.children) n += countSubtreePages(child);
  return n;
}

function removeLinksToPages(pageIds) {
  const set = new Set(pageIds);
  walk(ws.pages, (p) => {
    p.blocks = p.blocks.filter(b => !(b.type === "page" && set.has(b.pageId)));
  });
}

function deletePageSubtree(pageId) {
  const hit = findPage(pageId);
  if (!hit) return false;
  const { page, path } = hit;
  const ids = collectSubtreeIds(page);
  const idSet = new Set(ids);
  const taskIds = [];
  const collectTasks = (p) => {
    for (const b of p.blocks) {
      if (b.type === "checklist") for (const it of b.items) taskIds.push(it.id);
    }
    for (const c of p.children) collectTasks(c);
  };
  collectTasks(page);
  removeLinksToPages(ids);
  for (const id of ids) delete ws.expanded[id];
  const taskIdSet = new Set(taskIds);
  ws.taskOrder = ws.taskOrder.filter(id => !taskIdSet.has(id));
  const list = findParentList(pageId);
  const idx = list.findIndex(p => p.id === pageId);
  if (idx < 0) return false;
  list.splice(idx, 1);
  if (idSet.has(currentPageId)) {
    currentPageId = path.length ? path[path.length - 1].id : (ws.pages[0] && ws.pages[0].id) || null;
    if (!currentPageId) view = "map";
  }
  if (mapScopeId && idSet.has(mapScopeId)) mapScopeId = null;
  if (mapRenameId && idSet.has(mapRenameId)) mapRenameId = null;
  return true;
}

function confirmAndDeletePage(page) {
  const count = countSubtreePages(page);
  const label = `${page.icon} ${page.title || "Untitled"}`.trim();
  const msg = count > 1
    ? `Delete "${label}" and ${count - 1} sub-page${count - 1 === 1 ? "" : "s"}? This cannot be undone.`
    : `Delete "${label}"? This cannot be undone.`;
  if (!confirm(msg)) return;
  record(() => deletePageSubtree(page.id));
}

function addSubPage(parent, { title, afterBlockIndex, atIndex, noSave } = {}) {
  const child = newPage(title || "Untitled");
  parent.children.push(child);
  ws.expanded[parent.id] = true;
  const block = { id: uid(), type: "page", pageId: child.id };
  if (atIndex != null)
    parent.blocks.splice(atIndex, 0, block);
  else if (afterBlockIndex != null && afterBlockIndex >= 0)
    parent.blocks.splice(afterBlockIndex + 1, 0, block);
  else
    parent.blocks.push(block);
  if (!noSave) save();
  return child;
}

/* ---------- collect all tasks ---------- */
function allTasks() {
  const out = [];
  walk(ws.pages, (p, path) => {
    for (const b of p.blocks) if (b.type === "checklist")
      for (const it of b.items)
        out.push({ item: it, block: b, page: p, root: path[0] || p, path });
  });
  // manual order: keep known ids in saved order, append new ones
  const pos = new Map(ws.taskOrder.map((id, i) => [id, i]));
  out.sort((a, b) => (pos.has(a.item.id) ? pos.get(a.item.id) : 1e9) - (pos.has(b.item.id) ? pos.get(b.item.id) : 1e9));
  ws.taskOrder = out.map(t => t.item.id);
  return out;
}

/* ---------- DOM helpers ---------- */
const $ = s => document.querySelector(s);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function autoDir(node) {
  node.setAttribute("dir", "auto");
  return node;
}
function htmlToText(html) {
  const d = document.createElement("div");
  d.innerHTML = html || "";
  return (d.textContent || "").trim();
}
function serializePageContent(page) {
  const lines = [`${page.icon} ${page.title}`.trim(), ""];
  for (const b of page.blocks) {
    if (b.type === "text") {
      const t = htmlToText(b.html);
      if (t) lines.push(t, "");
    } else if (b.type === "checklist") {
      for (const it of b.items) {
        const mark = it.done ? "☑" : "☐";
        lines.push(`${mark} ${it.text || ""}`.trimEnd());
      }
      if (b.items.length) lines.push("");
    } else if (b.type === "table") {
      lines.push(b.columns.join("\t"));
      for (const row of b.rows) lines.push(row.join("\t"));
      lines.push("");
    } else if (b.type === "page") {
      const hit = findPage(b.pageId);
      lines.push(hit ? `${hit.page.icon} ${hit.page.title}` : "Missing page", "");
    } else if (b.type === "image") {
      lines.push("[Image]", "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
async function copyPageContent(page) {
  const text = serializePageContent(page);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/* ================= markdown import/export ================= */
function mdEscapeCell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function mdChildren(node) {
  return Array.from(node.childNodes).map(mdNodeToMarkdown).join("");
}
function mdNodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "b" || tag === "strong") return `**${mdChildren(node)}**`;
  if (tag === "s" || tag === "strike" || tag === "del") return `~~${mdChildren(node)}~~`;
  if (tag === "ul") {
    const items = Array.from(node.children).filter(c => c.tagName.toLowerCase() === "li");
    return items.map(li => `- ${mdChildren(li).trim()}`).join("\n") + (items.length ? "\n\n" : "");
  }
  if (tag === "ol") {
    const items = Array.from(node.children).filter(c => c.tagName.toLowerCase() === "li");
    return items.map((li, i) => `${i + 1}. ${mdChildren(li).trim()}`).join("\n") + (items.length ? "\n\n" : "");
  }
  if (tag === "li") return mdChildren(node).trim();
  if (tag === "p" || tag === "div") {
    const inner = mdChildren(node).trim();
    return inner ? inner + "\n\n" : "";
  }
  return mdChildren(node);
}
function htmlToMarkdown(html) {
  const d = document.createElement("div");
  d.innerHTML = html || "";
  return mdNodeToMarkdown(d).replace(/\n{3,}/g, "\n\n").trim();
}
function pageHeadingMd(page, depth) {
  const hashes = "#".repeat(Math.min(Math.max(depth, 1), 6));
  const title = page.icon && page.icon !== "📄" ? `${page.icon} ${page.title}` : page.title;
  return `${hashes} ${title}`;
}
function pageToMarkdown(page, depth) {
  const lines = [pageHeadingMd(page, depth), ""];
  for (const b of page.blocks) {
    if (b.type === "text") {
      const md = htmlToMarkdown(b.html);
      if (md) lines.push(md, "");
    } else if (b.type === "checklist") {
      for (const it of b.items) lines.push(`- [${it.done ? "x" : " "}] ${it.text || ""}`);
      if (b.items.length) lines.push("");
    } else if (b.type === "table") {
      lines.push("| " + b.columns.map(mdEscapeCell).join(" | ") + " |");
      lines.push("| " + b.columns.map(() => "---").join(" | ") + " |");
      for (const row of b.rows) {
        const padded = b.columns.map((_, i) => mdEscapeCell(row[i]));
        lines.push("| " + padded.join(" | ") + " |");
      }
      lines.push("");
    } else if (b.type === "page") {
      const hit = findPage(b.pageId);
      if (hit) {
        const childMd = pageToMarkdown(hit.page, depth + 1);
        if (childMd) lines.push(childMd, "");
      }
    }
  }
  return lines.join("\n").trimEnd();
}
function workspaceToMarkdown(workspace) {
  const parts = workspace.pages.map(p => pageToMarkdown(p, 1));
  return parts.join("\n\n").trimEnd() + "\n";
}
function downloadMarkdown() {
  const text = workspaceToMarkdown(ws);
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = URL.createObjectURL(blob);
  a.download = `pagetree-${date}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function mdEscapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function markdownInlineToHtml(text) {
  return mdEscapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>");
}
function splitIconTitle(text) {
  const m = text.match(/^(\p{Extended_Pictographic})\s+(.+)$/u);
  if (m) return { icon: m[1], title: m[2].trim() };
  return { icon: "📄", title: text.trim() || "Untitled" };
}
function markdownParagraphsToHtml(md) {
  const parts = md.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  return parts.map(part => {
    const lines = part.split("\n");
    if (lines.every(l => /^-\s+/.test(l) && !/^-\s+\[/.test(l))) {
      const items = lines.map(l => l.replace(/^-\s+/, ""));
      return "<ul>" + items.map(i => `<li>${markdownInlineToHtml(i)}</li>`).join("") + "</ul>";
    }
    if (lines.every(l => /^\d+\.\s+/.test(l))) {
      const items = lines.map(l => l.replace(/^\d+\.\s+/, ""));
      return "<ol>" + items.map(i => `<li>${markdownInlineToHtml(i)}</li>`).join("") + "</ol>";
    }
    return `<p>${markdownInlineToHtml(part.replace(/\n/g, "<br>"))}</p>`;
  }).join("");
}
function parseGfmTableRows(rows) {
  const cells = rows.map(r => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim().replace(/\\\|/g, "|")));
  if (cells.length < 2) return null;
  const columns = cells[0];
  const dataRows = cells.slice(2);
  return { id: uid(), type: "table", columns, rows: dataRows };
}
function markdownToPages(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const roots = [];
  const stack = [];
  let currentBlocks = null;
  let checklistBuf = null;
  let textBuf = [];
  let tableBuf = null;

  function flushText() {
    if (!textBuf.length) return;
    const md = textBuf.join("\n").trim();
    if (md && currentBlocks) currentBlocks.push({ id: uid(), type: "text", html: markdownParagraphsToHtml(md) });
    textBuf = [];
  }
  function flushChecklist() {
    if (!checklistBuf?.length) { checklistBuf = null; return; }
    if (currentBlocks) currentBlocks.push({ id: uid(), type: "checklist", items: checklistBuf });
    checklistBuf = null;
  }
  function flushTable() {
    if (!tableBuf?.length) { tableBuf = null; return; }
    const table = parseGfmTableRows(tableBuf);
    if (table && currentBlocks) currentBlocks.push(table);
    tableBuf = null;
  }
  function flushAll() {
    flushText();
    flushChecklist();
    flushTable();
  }
  function setCurrentPage(page) {
    flushAll();
    currentBlocks = page.blocks;
  }
  function pushPage(page, depth) {
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (depth === 1) {
      roots.push(page);
      stack.push({ page, depth });
    } else {
      const parent = stack[stack.length - 1]?.page;
      if (!parent) {
        roots.push(page);
        stack.length = 0;
        stack.push({ page, depth: 1 });
      } else {
        parent.children.push(page);
        parent.blocks.push({ id: uid(), type: "page", pageId: page.id });
        stack.push({ page, depth });
      }
    }
    setCurrentPage(page);
  }

  for (const line of lines) {
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const depth = hm[1].length;
      const { icon, title } = splitIconTitle(hm[2].trim());
      pushPage(newPage(title, icon), depth);
      continue;
    }
    if (!currentBlocks) continue;

    const trimmed = line.trim();
    if (/^\|.+\|$/.test(trimmed)) {
      flushText();
      flushChecklist();
      if (!tableBuf) tableBuf = [];
      tableBuf.push(trimmed);
      continue;
    }
    if (tableBuf) flushTable();

    const cm = line.match(/^-\s+\[([ xX])\]\s*(.*)$/);
    if (cm) {
      flushText();
      flushTable();
      if (!checklistBuf) checklistBuf = [];
      checklistBuf.push({ id: uid(), text: cm[2], done: cm[1].toLowerCase() === "x" });
      continue;
    }
    if (checklistBuf) flushChecklist();

    if (!trimmed) {
      flushText();
      continue;
    }
    textBuf.push(line);
  }
  flushAll();
  return roots;
}
function importMarkdownFile() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".md,text/markdown,text/plain";
  inp.onchange = () => {
    const file = inp.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const roots = markdownToPages(reader.result);
      if (!roots.length) {
        alert("No projects found in file. Use # headings for root projects.");
        return;
      }
      const firstId = roots[0].id;
      record(() => {
        for (const p of roots) ws.pages.push(p);
        currentPageId = firstId;
        view = "page";
      });
    };
    reader.onerror = () => alert("Could not read file.");
    reader.readAsText(file);
  };
  inp.click();
}

/* ================= sidebar tree ================= */
function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  const build = (page, depth) => {
    const wrap = el("div", "node");
    const row = el("div", "noderow" + (view === "page" && page.id === currentPageId ? " current" : ""));
    row.tabIndex = 0;
    const hasKids = page.children.length > 0;
    const open = ws.expanded[page.id] !== false; // default open
    const tw = el("button", "twisty", hasKids ? (open ? "▾" : "▸") : "·");
    tw.title = hasKids ? "Expand / collapse" : "";
    tw.onclick = e => { e.stopPropagation(); record(() => { ws.expanded[page.id] = !open; }, { refresh: "tree" }); };
    const label = autoDir(el("span", "nodelabel", `${page.icon} ${page.title}`));
    const add = el("button", "nodeadd", "＋");
    add.title = "Add sub-page";
    add.onclick = e => {
      e.stopPropagation();
      record(() => {
        const c = newPage();
        page.children.push(c);
        ws.expanded[page.id] = true;
        currentPageId = c.id;
        view = "page";
      });
      closeSidebar();
    };
    const del = el("button", "nodedel", "✕");
    del.title = "Delete page and sub-pages";
    del.onclick = e => {
      e.stopPropagation();
      confirmAndDeletePage(page);
      closeSidebar();
    };
    row.append(tw, label, add, del);
    row.onclick = () => openPage(page.id);
    row.onkeydown = e => { if (e.key === "Enter") openPage(page.id); };
    wrap.append(row);
    if (hasKids && open) {
      const kids = el("div", "nodekids");
      page.children.forEach(c => kids.append(build(c, depth + 1)));
      wrap.append(kids);
    }
    return wrap;
  };
  ws.pages.forEach(p => tree.append(build(p, 0)));
}

/* ================= page view ================= */
function openPage(id) {
  currentPageId = id; view = "page";
  mapRenameId = null;
  selectedBlockId = null;
  closeSidebar();
  render();
}

function getSelectedBlockIndex(page) {
  if (!selectedBlockId) return -1;
  return page.blocks.findIndex(b => b.id === selectedBlockId);
}
function getInsertIndex(page) {
  const idx = getSelectedBlockIndex(page);
  return idx >= 0 ? idx + 1 : page.blocks.length;
}
function setSelectedBlock(blockId) {
  selectedBlockId = blockId;
  document.querySelectorAll(".block.selected").forEach(n => n.classList.remove("selected"));
  const node = document.querySelector(`.block[data-blk="${blockId}"]`);
  if (node) node.classList.add("selected");
  updateDocToolbar();
}
function clearSelectedBlock() {
  selectedBlockId = null;
  document.querySelectorAll(".block.selected").forEach(n => n.classList.remove("selected"));
  updateDocToolbar();
}
function updateDocToolbar() {
  const toolbar = document.querySelector(".doctoolbar");
  if (!toolbar) return;
  const hit = findPage(currentPageId);
  if (!hit) return;
  const { page } = hit;
  const idx = getSelectedBlockIndex(page);
  const hasBlock = idx >= 0;
  const up = toolbar.querySelector('[data-action="move-up"]');
  const dn = toolbar.querySelector('[data-action="move-down"]');
  const rm = toolbar.querySelector('[data-action="delete-block"]');
  if (up) up.disabled = !hasBlock || idx === 0;
  if (dn) dn.disabled = !hasBlock || idx >= page.blocks.length - 1;
  if (rm) rm.disabled = !hasBlock;
}
function moveSelectedBlock(page, dir) {
  const idx = getSelectedBlockIndex(page);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= page.blocks.length) return;
  const b = page.blocks[idx];
  record(() => {
    page.blocks.splice(idx, 1);
    page.blocks.splice(newIdx, 0, b);
  });
}
function deleteSelectedBlock(page) {
  const idx = getSelectedBlockIndex(page);
  if (idx < 0) return;
  record(() => {
    page.blocks.splice(idx, 1);
    selectedBlockId = null;
  });
}
function renderPage(main) {
  const hit = findPage(currentPageId);
  if (!hit) { renderEmpty(main); return; }
  const { page, path } = hit;

  // Empty pages get a text block so you can type immediately.
  let focusStarter = null;
  if (page.blocks.length === 0) {
    focusStarter = { id: uid(), type: "text", html: "" };
    page.blocks.push(focusStarter);
    save();
  }

  const doc = el("div", "pagedoc");

  // breadcrumbs
  const crumbs = el("div", "crumbs");
  [...path, page].forEach((p, i, arr) => {
    const b = autoDir(el("button", null, `${p.icon} ${p.title}`));
    b.onclick = () => openPage(p.id);
    crumbs.append(b);
    if (i < arr.length - 1) crumbs.append(el("span", null, "›"));
  });
  doc.append(crumbs);

  // header
  const head = el("div", "pagehead");
  const icon = el("button", "bigicon", page.icon);
  icon.title = "Change icon (emoji)";
  icon.onclick = () => {
    const v = prompt("Type an emoji for this page:", page.icon);
    if (v) record(() => { page.icon = [...v.trim()][0] || page.icon; });
  };
  const title = autoDir(el("input", "titleinput"));
  title.value = page.title;
  title.placeholder = "Untitled";
  title.onfocus = () => { startEdit("title:" + page.id); clearSelectedBlock(); };
  title.onblur = () => endEdit();
  title.oninput = () => { page.title = title.value; save(); renderTree(); };
  head.append(icon, title);
  doc.append(head);

  doc.append(buildDocToolbar(page, path));

  const flow = el("div", "blocksflow");
  page.blocks.forEach((b, i) => flow.append(renderBlock(page, b, i)));
  doc.append(flow);

  main.append(doc);

  if (focusStarter) {
    requestAnimationFrame(() => {
      const node = document.querySelector(`.textblock[data-blk="${focusStarter.id}"]`);
      if (node) node.focus();
    });
  }
}

function insertBlock(page, index, type, { focus = true } = {}) {
  pushUndo();
  const i = Math.max(0, Math.min(index, page.blocks.length));
  if (type === "page") {
    addSubPage(page, { atIndex: i, noSave: true });
    save();
    render();
    return;
  }
  if (type === "image") {
    pickImageAt(page, i, true);
    return;
  }
  let block = null;
  if (type === "text") block = { id: uid(), type: "text", html: "" };
  else if (type === "checklist") block = { id: uid(), type: "checklist", items: [{ id: uid(), text: "", done: false }] };
  else if (type === "table") block = { id: uid(), type: "table", columns: ["Column 1", "Column 2"], rows: [["", ""]] };
  else return;
  page.blocks.splice(i, 0, block);
  save();
  render();
  if (focus && type === "text") {
    requestAnimationFrame(() => {
      const node = document.querySelector(`.textblock[data-blk="${block.id}"]`);
      if (node) node.focus();
    });
  }
}

function addTextBlock(page, focus = true) {
  insertBlock(page, page.blocks.length, "text", { focus });
}

function buildAddBlockMenu(page) {
  const wrap = el("div", "addmenu-wrap");
  const btn = el("button", "tbtn", "＋ Text");
  btn.title = "Add text block";
  btn.onclick = () => insertBlock(page, getInsertIndex(page), "text");

  const more = el("button", "tbtn addmenu-more", "▾");
  more.title = "Other block types";
  const menu = el("div", "addmenu");
  menu.hidden = true;
  const addItem = (label, type) => {
    const item = el("button", "addmenu-item", label);
    item.onclick = () => { menu.hidden = true; insertBlock(page, getInsertIndex(page), type); };
    menu.append(item);
  };
  addItem("Text", "text");
  addItem("Checklist", "checklist");
  addItem("Table", "table");
  addItem("Page", "page");
  addItem("Image", "image");
  more.onclick = e => {
    e.stopPropagation();
    const opening = menu.hidden;
    document.querySelectorAll(".addmenu").forEach(m => { m.hidden = true; });
    menu.hidden = !opening;
    if (!menu.hidden) {
      setTimeout(() => {
        const close = ev => {
          if (!wrap.contains(ev.target)) { menu.hidden = true; document.removeEventListener("click", close); }
        };
        document.addEventListener("click", close);
      }, 0);
    }
  };
  wrap.append(btn, more, menu);
  return wrap;
}

const TEXT_COLORS = ["#22303A", "#0E7C66", "#B3402E", "#B07D12", "#2456A6"];

function buildColorMenu() {
  const wrap = el("div", "colormenu-wrap");
  const btn = el("button", "tbtn color-trigger");
  btn.title = "Text color";
  btn.setAttribute("aria-label", "Text color");
  const dot = el("span", "color-trigger-dot");
  btn.append(dot);
  const menu = el("div", "colormenu");
  menu.hidden = true;
  for (const c of TEXT_COLORS) {
    const s = el("button", "colormenu-swatch");
    s.style.background = c;
    s.title = "Text color";
    s.onmousedown = e => e.preventDefault();
    s.onclick = () => {
      menu.hidden = true;
      applyFormat(() => document.execCommand("foreColor", false, c));
    };
    menu.append(s);
  }
  btn.onclick = e => {
    e.stopPropagation();
    const opening = menu.hidden;
    document.querySelectorAll(".colormenu").forEach(m => { m.hidden = true; });
    menu.hidden = !opening;
    if (!menu.hidden) {
      setTimeout(() => {
        const close = ev => {
          if (!wrap.contains(ev.target)) { menu.hidden = true; document.removeEventListener("click", close); }
        };
        document.addEventListener("click", close);
      }, 0);
    }
  };
  wrap.append(btn, menu);
  return wrap;
}

function buildDocToolbar(page, path) {
  const bar = el("div", "doctoolbar");
  bar.setAttribute("role", "toolbar");

  const insert = el("div", "doctoolbar-group");
  insert.append(buildAddBlockMenu(page));

  const fmt = el("div", "doctoolbar-group doctoolbar-fmt");
  const cmd = (label, title, fn) => {
    const btn = el("button", "tbtn", label);
    btn.dataset.fmt = "1";
    btn.title = title;
    btn.onmousedown = e => e.preventDefault();
    btn.onclick = fn;
    return btn;
  };
  fmt.append(
    cmd("B", "Bold", () => applyFormat(() => document.execCommand("bold"))),
    cmd("S̶", "Strikethrough", () => applyFormat(() => document.execCommand("strikeThrough"))),
    cmd("•", "Bulleted list", () => applyFormat(() => document.execCommand("insertUnorderedList"))),
    cmd("1.", "Numbered list", () => applyFormat(() => document.execCommand("insertOrderedList"))),
    cmd("📄", "Turn into page", () => turnSelectionIntoPage()),
    buildColorMenu(),
  );

  const blockActs = el("div", "doctoolbar-group");
  const act = (label, title, action, fn) => {
    const btn = el("button", "tbtn", label);
    btn.dataset.action = action;
    btn.title = title;
    btn.onclick = fn;
    return btn;
  };
  blockActs.append(
    act("↑", "Move up", "move-up", () => moveSelectedBlock(page, -1)),
    act("↓", "Move down", "move-down", () => moveSelectedBlock(page, 1)),
    act("✕", "Delete block", "delete-block", () => deleteSelectedBlock(page)),
  );

  const pageActs = el("div", "doctoolbar-group doctoolbar-page");
  const addSub = el("button", "tbtn", "＋ Page");
  addSub.title = "Add sub-page";
  addSub.onclick = () => record(() => addSubPage(page, { noSave: true }));
  const copyBtn = el("button", "tbtn", "Copy");
  copyBtn.title = "Copy content";
  copyBtn.onclick = async () => {
    const ok = await copyPageContent(page);
    if (ok) {
      const prev = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = prev; }, 1400);
    } else {
      alert("Could not copy to clipboard.");
    }
  };
  const del = el("button", "tbtn tbtn-danger", "Delete page");
  del.title = "Delete page and all sub-pages";
  del.onclick = () => confirmAndDeletePage(page);
  pageActs.append(addSub, copyBtn, del);

  bar.append(insert, fmt, blockActs, pageActs);
  requestAnimationFrame(() => updateDocToolbar());
  return bar;
}

function pickImageAt(page, index, historyPushed = false) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      if (!historyPushed) pushUndo();
      const i = Math.max(0, Math.min(index, page.blocks.length));
      page.blocks.splice(i, 0, { id: uid(), type: "image", dataUrl: r.result });
      save(); render();
    };
    r.readAsDataURL(f);
  };
  inp.click();
}

/* ---------- block rendering ---------- */
function renderBlock(page, b, idx) {
  const row = el("div", "blockrow");
  const wrap = el("div", "block");
  wrap.dataset.blk = b.id;
  if (selectedBlockId === b.id) wrap.classList.add("selected");
  wrap.onclick = e => {
    if (e.target.closest("button, input, .textblock, .tasktext, .tbl input, .pagelink")) return;
    setSelectedBlock(b.id);
  };

  if (b.type === "text") wrap.append(renderText(b));
  else if (b.type === "checklist") wrap.append(renderChecklist(b));
  else if (b.type === "table") wrap.append(renderTable(b));
  else if (b.type === "page") wrap.append(renderPageLink(b));
  else if (b.type === "image") { const d = el("div", "imgblock"); const img = new Image(); img.src = b.dataUrl; d.append(img); wrap.append(d); }
  row.append(wrap);
  return row;
}

function renderPageLink(b) {
  const row = autoDir(el("button", "pagelink"));
  const hit = findPage(b.pageId);
  if (!hit) {
    row.classList.add("missing");
    row.append(el("span", "pagelink-icon", "📄"), autoDir(el("span", "pagelink-label", "Missing page")));
    row.disabled = true;
    return row;
  }
  const { page: target } = hit;
  row.append(
    el("span", "pagelink-icon", target.icon),
    autoDir(el("span", "pagelink-label", target.title)),
  );
  row.onclick = () => openPage(b.pageId);
  return row;
}

/* text block with formatting */
function renderText(b) {
  const d = autoDir(el("div", "textblock"));
  d.contentEditable = "true";
  d.dataset.blk = b.id;
  d.innerHTML = b.html || "";
  d.oninput = () => { b.html = d.innerHTML; save(); };
  d.onfocus = () => { startEdit("text:" + b.id); setSelectedBlock(b.id); };
  d.onblur = () => { endEdit(); setTimeout(() => updateDocToolbar(), 0); };
  d.onpaste = e => {
    e.preventDefault();
    pushUndo();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    b.html = d.innerHTML;
    save();
  };
  return d;
}

function turnSelectionIntoPage() {
  const hit = findPage(currentPageId);
  if (!hit) return;
  const { page } = hit;
  const sel = window.getSelection();
  const title = (sel?.toString() || "").trim() || "Untitled";
  const node = sel?.anchorNode;
  const textEl = node?.nodeType === 3 ? node.parentElement?.closest(".textblock") : node?.closest?.(".textblock");
  if (!textEl) return;
  const blockIdx = page.blocks.findIndex(b => b.id === textEl.dataset.blk);
  if (blockIdx < 0 || page.blocks[blockIdx].type !== "text") return;
  record(() => {
    if (sel && !sel.isCollapsed) {
      document.execCommand("delete", false, null);
      page.blocks[blockIdx].html = textEl.innerHTML;
    }
    addSubPage(page, { title, afterBlockIndex: blockIdx, noSave: true });
  });
}

/* checklist block */
function renderChecklist(b) {
  const d = el("div", "checklist");
  b.items.forEach((it, i) => {
    const row = el("div", "taskrow" + (it.done ? " done" : ""));
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = it.done;
    cb.onchange = () => record(() => { it.done = cb.checked; });
    const txt = autoDir(el("input", "tasktext"));
    txt.value = it.text; txt.placeholder = "Task…";
    txt.onfocus = () => { startEdit("task:" + b.id + ":" + i); setSelectedBlock(b.id); };
    txt.onblur = () => endEdit();
    txt.oninput = () => { it.text = txt.value; save(); };
    txt.onkeydown = e => {
      if (e.key === "Enter") {
        e.preventDefault();
        record(() => b.items.splice(i + 1, 0, { id: uid(), text: "", done: false }));
        focusTask(b.id, i + 1);
      }
      if (e.key === "Backspace" && txt.value === "" && b.items.length > 1) {
        e.preventDefault();
        const prev = Math.max(0, i - 1);
        record(() => b.items.splice(i, 1));
        focusTask(b.id, prev);
      }
    };
    txt.dataset.blk = b.id; txt.dataset.i = i;
    const del = el("button", "rowdel", "✕");
    del.onclick = () => record(() => b.items.splice(i, 1));
    row.append(cb, txt, del);
    d.append(row);
  });
  const add = el("button", "addline", "＋ Add task");
  add.onclick = () => {
    record(() => b.items.push({ id: uid(), text: "", done: false }));
    focusTask(b.id, b.items.length - 1);
  };
  d.append(add);
  return d;
}
function focusTask(blockId, i) {
  requestAnimationFrame(() => {
    const inp = document.querySelector(`.tasktext[data-blk="${blockId}"][data-i="${i}"]`);
    if (inp) inp.focus();
  });
}

/* table block */
function renderTable(b) {
  const holder = el("div");
  const t = el("table", "tbl");
  const thr = el("tr");
  b.columns.forEach((c, ci) => {
    const th = el("th");
    const inp = autoDir(el("input")); inp.value = c;
    inp.onfocus = () => { startEdit("tbl:" + b.id + ":h:" + ci); setSelectedBlock(b.id); };
    inp.onblur = () => endEdit();
    inp.oninput = () => { b.columns[ci] = inp.value; save(); };
    th.append(inp); thr.append(th);
  });
  t.append(thr);
  b.rows.forEach((row, ri) => {
    const tr = el("tr");
    row.forEach((cell, ci) => {
      const td = el("td");
      const inp = autoDir(el("input")); inp.value = cell;
      inp.onfocus = () => { startEdit("tbl:" + b.id + ":r:" + ri + ":" + ci); setSelectedBlock(b.id); };
      inp.onblur = () => endEdit();
      inp.oninput = () => { row[ci] = inp.value; save(); };
      td.append(inp); tr.append(td);
    });
    t.append(tr);
  });
  holder.append(t);
  const tools = el("div", "tbltools");
  const addR = el("button", "chip", "＋ Row");
  addR.onclick = () => record(() => b.rows.push(b.columns.map(() => "")));
  const addC = el("button", "chip", "＋ Column");
  addC.onclick = () => record(() => { b.columns.push("Column " + (b.columns.length + 1)); b.rows.forEach(r => r.push("")); });
  const delR = el("button", "chip danger", "− Row");
  delR.onclick = () => { if (b.rows.length > 1) record(() => b.rows.pop()); };
  const delC = el("button", "chip danger", "− Column");
  delC.onclick = () => { if (b.columns.length > 1) record(() => { b.columns.pop(); b.rows.forEach(r => r.pop()); }); };
  tools.append(addR, addC, delR, delC);
  holder.append(tools);
  return holder;
}

/* ================= tasks view ================= */
function renderTasks(main) {
  main.append(el("h1", "viewtitle", "✅ All tasks"));
  main.append(el("p", "viewsub", "Every checkbox from every page, in one place. Checking here checks it there too."));

  const seg = el("div", "segment");
  const g = el("button", tasksMode === "grouped" ? "active" : "", "By project");
  const f = el("button", tasksMode === "flat" ? "active" : "", "My order");
  g.onclick = () => record(() => { tasksMode = "grouped"; });
  f.onclick = () => record(() => { tasksMode = "flat"; });
  seg.append(g, f);
  main.append(seg);

  const tasks = allTasks();
  if (!tasks.length) {
    const e = el("div", "empty");
    e.append(el("div", "big", "🍃"), el("p", null, "No tasks yet. Add a checklist to any page and it shows up here."));
    main.append(e);
    return;
  }

  const taskRow = (t, flat) => {
    const row = el("div", "gtask" + (t.item.done ? " done" : ""));
    row.dataset.tid = t.item.id;
    if (flat) {
      const grab = el("span", "grab", "⠿");
      grab.title = "Drag to reorder";
      row.draggable = true;
      row.ondragstart = e => { row.classList.add("dragging"); e.dataTransfer.setData("text/plain", t.item.id); };
      row.ondragend = () => row.classList.remove("dragging");
      row.ondragover = e => { e.preventDefault(); row.classList.add("dropover"); };
      row.ondragleave = () => row.classList.remove("dropover");
      row.ondrop = e => {
        e.preventDefault(); row.classList.remove("dropover");
        moveTask(e.dataTransfer.getData("text/plain"), t.item.id);
      };
      row.append(grab);
    }
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = t.item.done;
    cb.onchange = () => record(() => { t.item.done = cb.checked; });
    const mainCol = el("div", "gt-main");
    mainCol.append(autoDir(el("div", "gt-text", t.item.text || "(empty task)")));
    const crumb = el("div", "gt-crumb");
    const link = autoDir(el("button", null, `${t.root.icon} ${t.root.title}` + (t.page.id !== t.root.id ? ` › ${t.page.icon} ${t.page.title}` : "")));
    link.title = "Open the page this task lives in";
    link.onclick = () => openPage(t.page.id);
    crumb.append(link);
    mainCol.append(crumb);
    row.append(cb, mainCol);
    if (flat) {
      const mv = el("div", "movebtns");
      const u = el("button", null, "▲"), d = el("button", null, "▼");
      u.title = "Move up"; d.title = "Move down";
      u.onclick = () => nudgeTask(t.item.id, -1);
      d.onclick = () => nudgeTask(t.item.id, +1);
      mv.append(u, d);
      row.append(mv);
    }
    return row;
  };

  if (tasksMode === "grouped") {
    const groups = new Map();
    for (const t of tasks) {
      if (!groups.has(t.root.id)) groups.set(t.root.id, { root: t.root, list: [] });
      groups.get(t.root.id).list.push(t);
    }
    for (const { root, list } of groups.values()) {
      main.append(autoDir(el("div", "groupname", `${root.icon} ${root.title}`)));
      list.forEach(t => main.append(taskRow(t, false)));
    }
  } else {
    tasks.forEach(t => main.append(taskRow(t, true)));
  }
}
function moveTask(dragId, dropId) {
  if (dragId === dropId) return;
  const o = ws.taskOrder;
  const from = o.indexOf(dragId), to = o.indexOf(dropId);
  if (from < 0 || to < 0) return;
  record(() => {
    o.splice(from, 1);
    o.splice(to, 0, dragId);
  });
}
function nudgeTask(id, dir) {
  const o = ws.taskOrder;
  const i = o.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= o.length) return;
  record(() => { [o[i], o[j]] = [o[j], o[i]]; });
}

/* ================= mindmap layout & view ================= */
const MM = { nodeH: 44, hGap: 56, vGap: 14, pad: 32, treeGap: 40, labelPad: 26, tailW: 54 };
let mmMeasureCtx = null;

function mmIsPhone() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function mmMapRoots() {
  if (mapScopeId) {
    const hit = findPage(mapScopeId);
    if (hit) return [hit.page];
  }
  return ws.pages;
}

function mmNodeH() {
  return mmIsPhone() ? 48 : MM.nodeH;
}

function mmLabelWidth(page, isRoot) {
  if (!mmMeasureCtx) {
    const c = document.createElement("canvas");
    mmMeasureCtx = c.getContext("2d");
  }
  mmMeasureCtx.font = (isRoot ? "600 " : "") + "14.4px system-ui, -apple-system, Segoe UI, sans-serif";
  const text = `${page.icon} ${page.title || "Untitled"}`;
  return Math.ceil(mmMeasureCtx.measureText(text).width) + MM.labelPad;
}

function mmNodeDims(page, isRoot) {
  const phone = mmIsPhone();
  const openW = mmLabelWidth(page, isRoot) + (phone ? 8 : 0);
  const twistyW = page.children.length ? (phone ? 40 : 26) : 0;
  const tailW = phone ? 84 : MM.tailW;
  const rowW = twistyW + openW + tailW;
  return { openW, rowW, twistyW };
}

function mmIsOpen(page) {
  return ws.expanded[page.id] !== false;
}

function mmComputeColumns(pages) {
  const depthMax = [];
  function walk(page, depth, isRoot) {
    const { rowW } = mmNodeDims(page, isRoot);
    depthMax[depth] = Math.max(depthMax[depth] || 0, rowW);
    if (mmIsOpen(page) && page.children.length)
      for (const c of page.children) walk(c, depth + 1, false);
  }
  for (const p of pages) walk(p, 0, true);
  const colX = [];
  let x = MM.pad;
  for (let d = 0; d < depthMax.length; d++) {
    colX[d] = x;
    x += depthMax[d] + MM.hGap;
  }
  return { colX, canvasW: x + MM.pad };
}

function layoutMindmapTree(page, depth, isRoot, yCursor, colX) {
  const x = colX[depth] || MM.pad;
  const dims = mmNodeDims(page, isRoot);
  const showKids = mmIsOpen(page) && page.children.length > 0;
  const nodes = [];
  const edges = [];

  if (!showKids) {
    const nh = mmNodeH();
    const yTop = yCursor.val;
    const yCenter = yTop + nh / 2;
    nodes.push({ page, x, y: yCenter, isRoot, ...dims });
    yCursor.val += nh + MM.vGap;
    return { nodes, edges, height: nh + MM.vGap };
  }

  const childStart = yCursor.val;
  let childHeight = 0;
  const childLayouts = [];

  for (const child of page.children) {
    const sub = layoutMindmapTree(child, depth + 1, false, yCursor, colX);
    nodes.push(...sub.nodes);
    edges.push(...sub.edges);
    childHeight += sub.height;
    childLayouts.push(sub.nodes[0]);
  }

  const yCenter = (childLayouts[0].y + childLayouts[childLayouts.length - 1].y) / 2;
  const node = { page, x, y: yCenter, isRoot, ...dims };
  nodes.unshift(node);
  const parentRight = x + dims.twistyW + dims.openW;
  for (const child of childLayouts) {
    edges.push({
      x1: parentRight,
      y1: yCenter,
      x2: child.x + child.twistyW,
      y2: child.y,
    });
  }

  const subtreeH = Math.max(mmNodeH() + MM.vGap, childHeight);
  if (yCursor.val - childStart < subtreeH) yCursor.val = childStart + subtreeH;
  return { nodes, edges, height: subtreeH };
}

function computeMindmapLayout(pages) {
  const { colX, canvasW } = mmComputeColumns(pages);
  const nodes = [];
  const edges = [];
  const yCursor = { val: MM.pad };
  let first = true;
  for (const p of pages) {
    if (!first) yCursor.val += MM.treeGap;
    first = false;
    const sub = layoutMindmapTree(p, 0, true, yCursor, colX);
    nodes.push(...sub.nodes);
    edges.push(...sub.edges);
  }
  return { nodes, edges, width: canvasW, height: yCursor.val + MM.pad };
}

function mmFitScale(pan, cw, ch) {
  const pad = 20;
  const aw = Math.max(40, pan.clientWidth - pad);
  const ah = Math.max(40, pan.clientHeight - pad);
  return Math.min(aw / cw, ah / ch) * 0.96;
}

function mmActiveScale(pan, cw, ch) {
  const scale = mapZoomAuto ? mmFitScale(pan, cw, ch) : mapScale;
  return Math.min(3, Math.max(0.12, scale));
}

function mmApplyZoom(pan, scaler, canvas, lbl) {
  if (!mapLayout || !pan) return;
  const { width: cw, height: ch } = mapLayout;
  if (!cw || !ch) return;
  const scale = mmActiveScale(pan, cw, ch);
  canvas.style.width = cw + "px";
  canvas.style.height = ch + "px";
  canvas.style.transform = `scale(${scale})`;
  scaler.style.width = Math.ceil(cw * scale) + "px";
  scaler.style.height = Math.ceil(ch * scale) + "px";
  if (lbl) lbl.textContent = mapZoomAuto ? "Fit" : Math.round(scale * 100) + "%";
}

function mmScheduleZoom(pan, scaler, canvas, lbl, tries = 0) {
  if (!pan || !mapLayout) return;
  if (pan.clientWidth < 2 || pan.clientHeight < 2) {
    if (tries < 24) {
      requestAnimationFrame(() => mmScheduleZoom(pan, scaler, canvas, lbl, tries + 1));
      return;
    }
    // Last resort: layout had no size yet — still paint at 100% so nodes aren't invisible.
    canvas.style.width = mapLayout.width + "px";
    canvas.style.height = mapLayout.height + "px";
    canvas.style.transform = "scale(1)";
    scaler.style.width = mapLayout.width + "px";
    scaler.style.height = mapLayout.height + "px";
    if (lbl) lbl.textContent = "100%";
    return;
  }
  mmApplyZoom(pan, scaler, canvas, lbl);
}

function mmZoomHistory() {
  const pan = $("#mmPan");
  if (!pan) return;
  if (!pan._zoomUndo) {
    pushUndo();
    pan._zoomUndo = true;
  }
  clearTimeout(pan._zoomUndoT);
  pan._zoomUndoT = setTimeout(() => {
    pan._zoomUndo = false;
    save();
  }, 400);
}

function mmZoomBy(factor, { history = true } = {}) {
  const pan = $("#mmPan");
  const scaler = $("#mmScaler");
  const canvas = $("#mmCanvas");
  const lbl = $("#mmZoomLbl");
  if (!pan || !mapLayout) return;
  if (history) mmZoomHistory();
  if (mapZoomAuto) {
    mapZoomAuto = false;
    mapScale = mmFitScale(pan, mapLayout.width, mapLayout.height);
  }
  mapScale = Math.min(3, Math.max(0.12, mapScale * factor));
  mmApplyZoom(pan, scaler, canvas, lbl);
}

function mmZoomFit() {
  record(() => { mapZoomAuto = true; });
}

function mmTouchDist(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function mmWireZoom(pan, scaler, canvas, lbl) {
  pan.onwheel = e => {
    e.preventDefault();
    mmZoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  let pinchStartDist = 0;
  let pinchStartScale = 1;
  const onTouchStart = e => {
    if (e.touches.length === 2 && mapLayout) {
      if (!pan._pinchUndo) { pushUndo(); pan._pinchUndo = true; }
      pinchStartDist = mmTouchDist(e.touches[0], e.touches[1]);
      if (mapZoomAuto) {
        mapZoomAuto = false;
        mapScale = mmFitScale(pan, mapLayout.width, mapLayout.height);
      }
      pinchStartScale = mapScale;
    }
  };
  const onTouchMove = e => {
    if (e.touches.length === 2 && pinchStartDist > 0 && mapLayout) {
      e.preventDefault();
      const dist = mmTouchDist(e.touches[0], e.touches[1]);
      mapZoomAuto = false;
      mapScale = Math.min(3, Math.max(0.12, pinchStartScale * (dist / pinchStartDist)));
      mmApplyZoom(pan, scaler, canvas, lbl);
    }
  };
  const onTouchEnd = e => {
    if (e.touches.length < 2) {
      if (pinchStartDist > 0) save();
      pinchStartDist = 0;
      pan._pinchUndo = false;
    }
  };
  pan.addEventListener("touchstart", onTouchStart, { passive: true });
  pan.addEventListener("touchmove", onTouchMove, { passive: false });
  pan.addEventListener("touchend", onTouchEnd);
  pan.addEventListener("touchcancel", onTouchEnd);

  if (pan._mmResizeObs) pan._mmResizeObs.disconnect();
  pan._mmResizeObs = new ResizeObserver(() => {
    if (mapZoomAuto) mmScheduleZoom(pan, scaler, canvas, lbl);
  });
  pan._mmResizeObs.observe(pan);
  mmScheduleZoom(pan, scaler, canvas, lbl);
}

function finishMapRename(page, title) {
  const next = (title || "").trim() || "Untitled";
  mapRenameId = null;
  endEdit();
  if (next === page.title) { render(); return; }
  page.title = next;
  save();
  render();
}

function buildMapNode(n) {
  const wrap = el("div", "mmap-node" + (n.isRoot ? " root" : ""));
  wrap.style.left = n.x + "px";
  wrap.style.top = (n.y - mmNodeH() / 2) + "px";
  wrap.style.width = n.rowW + "px";
  wrap.style.height = mmNodeH() + "px";

  if (n.page.children.length) {
    const tw = el("button", "mmap-twisty", mmIsOpen(n.page) ? "▾" : "▸");
    tw.title = "Expand / collapse";
    tw.onclick = e => {
      e.stopPropagation();
      record(() => { ws.expanded[n.page.id] = !mmIsOpen(n.page); });
    };
    wrap.append(tw);
  }

  if (mapRenameId === n.page.id) {
    const inp = autoDir(el("input", "mmap-rename"));
    inp.style.width = n.openW + "px";
    inp.value = n.page.title === "Untitled" ? "" : n.page.title;
    inp.placeholder = "Name…";
    inp.onfocus = () => startEdit("mmap:" + n.page.id);
    inp.onkeydown = e => {
      if (e.key === "Enter") { e.preventDefault(); finishMapRename(n.page, inp.value); }
      if (e.key === "Escape") { mapRenameId = null; render(); }
    };
    inp.onblur = () => finishMapRename(n.page, inp.value);
    inp.onclick = e => e.stopPropagation();
    wrap.append(inp);
  } else {
    const btn = el("button", "mmap-open");
    btn.style.width = n.openW + "px";
    const label = autoDir(el("span", "mmap-label", `${n.page.icon} ${n.page.title}`));
    btn.append(label);
    btn.title = "Open page";
    btn.onclick = () => openPage(n.page.id);
    wrap.append(btn);

    const rename = el("button", "mmap-name", "✎");
    rename.title = "Rename";
    rename.setAttribute("aria-label", "Rename page");
    rename.onclick = e => {
      e.stopPropagation();
      mapRenameId = n.page.id;
      render();
    };
    wrap.append(rename);
  }

  const del = el("button", "mmap-del", "✕");
  del.title = "Delete page and sub-pages";
  del.setAttribute("aria-label", "Delete page");
  del.onclick = e => {
    e.stopPropagation();
    confirmAndDeletePage(n.page);
  };
  wrap.append(del);

  const add = el("button", "mmap-add", "＋");
  add.title = "Add sub-page";
  add.onclick = e => {
    e.stopPropagation();
    record(() => {
      const c = newPage("Untitled", "📄");
      n.page.children.push(c);
      ws.expanded[n.page.id] = true;
      mapRenameId = c.id;
      view = "map";
    });
  };
  wrap.append(add);
  return wrap;
}

function renderMap(main) {
  const roots = mmMapRoots();
  const scoped = mapScopeId && roots.length === 1 && roots[0].id === mapScopeId;
  const scopePage = scoped ? roots[0] : null;

  const head = el("div", "mmap-head");
  const title = scoped
    ? `🗺️ Mindmap · ${scopePage.icon} ${scopePage.title || "Untitled"}`
    : "🗺️ Mindmap";
  head.append(el("h1", "viewtitle", title));
  const sub = scoped
    ? "This page and its sub-pages. Pinch or scroll to zoom."
    : "Projects branch left to right. Click to write, ✎ to rename. Pinch or scroll to zoom.";
  head.append(el("p", "viewsub", sub));
  const zoomCtl = el("div", "mmap-zoomctl");
  const zoomOut = el("button", "mmap-zoombtn", "−");
  zoomOut.title = "Zoom out";
  zoomOut.onclick = () => mmZoomBy(1 / 1.15);
  const zoomLbl = el("span", "mmap-zoomlbl", "Fit");
  zoomLbl.id = "mmZoomLbl";
  const zoomIn = el("button", "mmap-zoombtn", "+");
  zoomIn.title = "Zoom in";
  zoomIn.onclick = () => mmZoomBy(1.15);
  const zoomFit = el("button", "mmap-zoombtn mmap-zoomfit", "Fit");
  zoomFit.title = "Fit to screen";
  zoomFit.onclick = () => mmZoomFit();
  zoomCtl.append(zoomOut, zoomLbl, zoomIn, zoomFit);
  head.append(zoomCtl);
  if (scoped) {
    const showAll = el("button", "ghostbtn mmap-showall", "Show all projects");
    showAll.onclick = () => { mapScopeId = null; mapZoomAuto = true; render(); };
    head.append(showAll);
  } else {
    const addRoot = el("button", "ghostbtn mmap-newroot", "＋ New project");
    addRoot.onclick = () => record(() => {
      const p = newPage("New project", "📁");
      ws.pages.push(p);
      mapRenameId = p.id;
    });
    head.append(addRoot);
  }
  main.append(head);

  if (!roots.length) {
    const e = el("div", "mmap-empty");
    e.append(el("div", "big", "🌿"));
    e.append(el("p", null, "No projects yet. Create your first one to start mapping."));
    const btn = el("button", "ghostbtn", "＋ Create first project");
    btn.onclick = () => record(() => {
      const p = newPage("New project", "📁");
      ws.pages.push(p);
      mapRenameId = p.id;
    });
    e.append(btn);
    main.append(e);
    return;
  }

  let layout;
  try {
    layout = computeMindmapLayout(roots);
  } catch (err) {
    console.error("Mindmap layout failed", err);
    const e = el("div", "mmap-empty");
    e.append(el("p", null, "Could not draw the map. Try refreshing the page."));
    main.append(e);
    return;
  }
  const { nodes, edges, width, height } = layout;
  mapLayout = { width, height };

  const viewport = el("div", "mindmap-viewport");
  const pan = el("div", "mindmap-pan");
  pan.id = "mmPan";
  const scaler = el("div", "mindmap-scaler");
  scaler.id = "mmScaler";
  const canvas = el("div", "mindmap");
  canvas.id = "mmCanvas";
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "mindmap-edges");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  for (const edge of edges) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const mx = (edge.x1 + edge.x2) / 2;
    path.setAttribute("d", `M ${edge.x1} ${edge.y1} C ${mx} ${edge.y1}, ${mx} ${edge.y2}, ${edge.x2} ${edge.y2}`);
    path.setAttribute("class", "mindmap-edge");
    svg.appendChild(path);
  }
  canvas.append(svg);

  const layer = el("div", "mindmap-nodes");
  for (const n of nodes) layer.append(buildMapNode(n));
  canvas.append(layer);
  scaler.append(canvas);
  pan.append(scaler);
  viewport.append(pan);
  main.append(viewport);

  const lbl = $("#mmZoomLbl");
  mmWireZoom(pan, scaler, canvas, lbl);

  if (mapRenameId) {
    requestAnimationFrame(() => {
      const inp = main.querySelector(".mmap-rename");
      if (inp) { inp.focus(); inp.select(); }
    });
  }
}

function renderEmpty(main) {
  const e = el("div", "empty");
  e.append(el("div", "big", "🌿"));
  e.append(el("p", null, "Nothing here yet. Create your first project from the sidebar."));
  main.append(e);
}

/* ================= shell ================= */
function render() {
  if (!ws) return;
  renderTree();
  const navTasks = $("#navTasks"), navMap = $("#navMap");
  if (navTasks) navTasks.classList.toggle("active", view === "tasks");
  if (navMap) navMap.classList.toggle("active", view === "map");
  const main = $("#main");
  if (!main) return;
  main.className = view === "map" ? "mmap-main" : "";
  main.innerHTML = "";
  if (view === "tasks") renderTasks(main);
  else if (view === "map") renderMap(main);
  else if (currentPageId && findPage(currentPageId)) renderPage(main);
  else if (ws.pages.length) { currentPageId = ws.pages[0].id; renderPage(main); }
  else renderEmpty(main);
  if (view === "map") {
    requestAnimationFrame(() => {
      const pan = $("#mmPan"), scaler = $("#mmScaler"), canvas = $("#mmCanvas"), lbl = $("#mmZoomLbl");
      if (pan && mapLayout) mmScheduleZoom(pan, scaler, canvas, lbl);
    });
  }
  updateUndoButtons();
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#scrim").classList.remove("show");
  $("#menuBtn").setAttribute("aria-expanded", "false");
}
function toggleSidebar() {
  const open = $("#sidebar").classList.toggle("open");
  $("#scrim").classList.toggle("show", open);
  $("#menuBtn").setAttribute("aria-expanded", open ? "true" : "false");
}

/* ---------- boot ---------- */
(async function boot() {
  try {
    sb = initSupabase();

    const on = (id, fn) => {
      const node = document.getElementById(id);
      if (node) node.onclick = fn;
    };

    on("navTasks", () => { view = "tasks"; closeSidebar(); render(); });
    on("navMap", () => {
      view = "map";
      mapZoomAuto = true;
      mapScopeId = currentPageId || null;
      closeSidebar();
      render();
    });
    on("navUndo", undo);
    on("navRedo", redo);
    on("navAccount", async () => {
      if (!session) return;
      if (!confirm("Sign out of Pagetree?")) return;
      try { await sb?.auth.signOut(); } catch (e) { console.warn(e); }
      await handleSignedOut();
    });
    on("newRootBtn", () => record(() => {
      const p = newPage("New project", "📁");
      ws.pages.push(p);
      currentPageId = p.id;
      view = "page";
    }));
    on("exportMdBtn", () => downloadMarkdown());
    on("importMdBtn", () => importMarkdownFile());
    on("menuBtn", toggleSidebar);
    on("scrim", closeSidebar);
    const menuBtn = $("#menuBtn");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    on("brand", () => { view = "map"; mapZoomAuto = true; mapScopeId = null; render(); });

    document.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key === "y" || (e.key === "z" && e.shiftKey) || (e.key === "Z" && e.shiftKey)) { e.preventDefault(); redo(); }
    });

    window.addEventListener("online", () => { if (session) queueCloudSave(); });

    if (sb) {
      sb.auth.onAuthStateChange(async (event, next) => {
        // Explicit sign-in from the form should leave offline mode.
        if (event === "SIGNED_IN") preferOffline = false;
        if (preferOffline && event !== "SIGNED_OUT") return;

        session = next;
        try {
          // Token refresh only updates the session — do not re-run workspace load.
          if (event === "TOKEN_REFRESHED") return;
          if (event === "SIGNED_OUT") {
            await handleSignedOut();
            return;
          }
          if ((event === "INITIAL_SESSION" || event === "SIGNED_IN") && session?.user) {
            await startApp();
          } else if (event === "INITIAL_SESSION" && !session?.user) {
            showAuthGate();
          }
        } catch (e) {
          console.error("auth state handler failed", e);
          showAuthGate(e.message || "Auth error. Continue offline or try again.");
        }
      });
      try {
        const { data } = await sb.auth.getSession();
        session = data.session;
        if (session?.user && !preferOffline) await startApp();
        else if (!session?.user) showAuthGate();
      } catch (e) {
        console.warn("getSession failed", e);
        showAuthGate();
      }
    } else {
      await startOfflineApp();
    }

    if ("serviceWorker" in navigator) {
      try {
        const reg = await navigator.serviceWorker.register("sw.js");
        reg.update().catch(() => {});
        navigator.serviceWorker.addEventListener("message", ev => {
          if (ev.data?.type === "pagetree-updated") location.reload();
        });
      } catch (e) { console.warn("SW failed", e); }
    }
  } catch (e) {
    console.error("boot failed", e);
    try { await startOfflineApp(); } catch (_) {
      showAuthGate("App failed to start. Refresh the page.");
    }
  }
})();
