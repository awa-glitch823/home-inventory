"use strict";

// カテゴリの順序・色はここだけで管理します。
const CATEGORY_CONFIG = [
  { name: "キッチン", color: "#22c55e" }, { name: "トイレ", color: "#3b82f6" },
  { name: "洗面所", color: "#06b6d4" }, { name: "お風呂", color: "#a855f7" },
  { name: "洗濯", color: "#f59e0b" }, { name: "掃除", color: "#ef4444" },
  { name: "その他", color: "#9ca3af" }
];
const CATEGORIES = CATEGORY_CONFIG.map((category) => category.name);
const DB_NAME = "homeInventoryDB";
const STORE_NAME = "items";
const CHECK_STORE_NAME = "shoppingChecks";
const DB_VERSION = 2;
const screens = document.querySelectorAll(".screen");
const navButtons = document.querySelectorAll(".nav-button");
const form = document.getElementById("add-form");
const addButton = form.querySelector(".add-button");
const cancelEditButton = document.getElementById("edit-cancel");
const formMessage = document.getElementById("form-message");
const inventoryMessage = document.getElementById("inventory-message");
const inventoryList = document.getElementById("inventory-list");
const cardTemplate = document.getElementById("inventory-card-template");
const shoppingList = document.getElementById("shopping-list");
const shoppingMessage = document.getElementById("shopping-message");
const shoppingCardTemplate = document.getElementById("shopping-card-template");
const fields = { name: document.getElementById("product-name"), category: document.getElementById("product-category"),
  quantity: document.getElementById("initial-stock"), reorderPoint: document.getElementById("reorder-point") };
const fieldErrors = { name: document.getElementById("name-error"), category: document.getElementById("category-error"),
  quantity: document.getElementById("quantity-error"), reorderPoint: document.getElementById("reorder-error") };
let currentItems = [];
let checkedIds = new Set();
let databasePromise;
let appReady = false;
let isSaving = false;
let managementUI = null;
let managementBusy = false;
let managementState = { stage: "idle", target: null, verifiedItems: null };
let editingItem = null;
let pendingWrites = 0;
let writeQueue = Promise.resolve();
const cardErrors = new Map();
const checkErrors = new Map();

function normalizedName(name) { return name.trim().toLowerCase(); }
function shoppingTarget(item) { return item.quantity <= item.reorderPoint; }
function formValues() {
  return { name: fields.name.value.trim(), category: fields.category.value,
    quantity: fields.quantity.value === "" ? NaN : Number(fields.quantity.value),
    reorderPoint: fields.reorderPoint.value === "" ? NaN : Number(fields.reorderPoint.value) };
}
function formChanged() {
  if (!editingItem) return false;
  const value = formValues();
  return Object.keys(value).some((key) => value[key] !== (key === "name" ? editingItem.name.trim() : editingItem[key]));
}
function clearFormErrors() {
  Object.keys(fields).forEach((key) => { fieldErrors[key].hidden = true; fields[key].removeAttribute("aria-invalid"); });
  formMessage.hidden = true;
}
function displayFieldError(key, message) {
  fieldErrors[key].textContent = message;
  fieldErrors[key].hidden = false;
  fields[key].setAttribute("aria-invalid", "true");
}
function resetForm() {
  editingItem = null;
  fields.name.value = ""; fields.category.value = CATEGORIES[0]; fields.quantity.value = "0"; fields.reorderPoint.value = "0";
  document.getElementById("add-title").textContent = "商品追加";
  addButton.textContent = "追加"; cancelEditButton.hidden = true; clearFormErrors();
}
function showScreen(id, force = false) {
  if (!document.getElementById(id)?.classList.contains("screen")) return false;
  if (!force && (managementBusy || isSaving || pendingWrites)) return false;
  if (editingItem && id !== "add") {
    if (!force && formChanged() && !window.confirm("変更を破棄しますか？")) return false;
    resetForm();
  }
  if (id !== "settings" && managementUI) resetDataManagement();
  screens.forEach((screen) => { screen.hidden = screen.id !== id; });
  navButtons.forEach((button) => {
    const active = button.dataset.screen === id;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
  syncControls();
  return true;
}
navButtons.forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screen)));

function syncControls() {
  const locked = !appReady || managementBusy || isSaving;
  Object.values(fields).forEach((field) => { field.disabled = locked; });
  addButton.disabled = locked || pendingWrites > 0 || (editingItem && !formChanged());
  cancelEditButton.disabled = locked || pendingWrites > 0;
  navButtons.forEach((button) => { button.disabled = managementBusy || isSaving || pendingWrites > 0; });
  inventoryList.querySelectorAll(".inventory-card").forEach((card) => {
    const item = currentItems.find((entry) => entry.id === Number(card.dataset.itemId));
    if (!item) return;
    card.querySelector(".decrease-button").disabled = locked || item.quantity <= 0;
    card.querySelector(".increase-button").disabled = locked || item.quantity >= 9999;
    [".card-more", ".card-edit", ".card-delete"].forEach((selector) => { card.querySelector(selector).disabled = locked || pendingWrites > 0; });
  });
  shoppingList.querySelectorAll("input").forEach((input) => { input.disabled = locked || pendingWrites > 0; });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("IndexedDBを利用できません。")); return; }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      // 既存itemsは変更しません。チェックだけ別ストアへ保存します。
      if (!db.objectStoreNames.contains(CHECK_STORE_NAME)) db.createObjectStore(CHECK_STORE_NAME, { keyPath: "itemId" });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = undefined; appReady = false; syncControls(); };
      db.onclose = () => { databasePromise = undefined; appReady = false; syncControls(); };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("他のタブを閉じて再読み込みしてください。")); };
  }).catch((error) => { databasePromise = undefined; throw error; });
  return databasePromise;
}
async function readItems() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || new Error("商品を読み込めませんでした。"));
  });
}
async function readState() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, CHECK_STORE_NAME], "readonly");
    const items = tx.objectStore(STORE_NAME).getAll(), checks = tx.objectStore(CHECK_STORE_NAME).getAll();
    tx.oncomplete = () => resolve({ items: items.result, checks: checks.result });
    tx.onabort = () => reject(tx.error || new Error("データを読み込めませんでした。"));
  });
}
// 読み取り・検証・更新・チェックの解除を同じトランザクションで実施。
async function mutateState(action) {
  if (!appReady) throw new Error("初期化が完了していません。");
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, CHECK_STORE_NAME], "readwrite");
    const items = tx.objectStore(STORE_NAME), checks = tx.objectStore(CHECK_STORE_NAME);
    const initialItems = items.getAll(), initialChecks = checks.getAll();
    let finalItems, finalChecks, result, reason;
    tx.oncomplete = () => resolve({ items: finalItems.result, checks: finalChecks.result, result });
    tx.onabort = () => reject(reason || tx.error || new Error("保存に失敗しました。"));
    initialChecks.onsuccess = () => {
      try {
        result = action({ items, checks, data: initialItems.result, checked: initialChecks.result });
        finalItems = items.getAll(); finalChecks = checks.getAll();
      } catch (error) { reason = error; tx.abort(); }
    };
  });
}
function queueWrite(task) {
  pendingWrites++; syncControls();
  const pending = writeQueue.then(task);
  writeQueue = pending.catch(() => {});
  return pending.finally(() => { pendingWrites--; syncControls(); });
}
function validateInput(value, original = null) {
  const errors = {};
  if (!value.name) errors.name = "商品名を入力してください。";
  else if ((!original || value.name !== original.name.trim()) && Array.from(value.name).length > 50) errors.name = "商品名は50文字以内で入力してください。";
  if (!CATEGORIES.includes(value.category)) errors.category = "カテゴリを選択してください。";
  for (const key of ["quantity", "reorderPoint"]) {
    if ((!original || value[key] !== original[key]) && (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 9999)) {
      errors[key] = "0～9999の整数を入力してください。";
    }
  }
  return errors;
}
async function persistItem(value, original = null) {
  return mutateState(({ items, checks, data }) => {
    const existing = original ? data.find((entry) => entry.id === original.id) : null;
    if (original && !existing) throw new Error("商品が見つかりません。再読み込みしてください。");
    if (original && !deepEqual(existing, original)) throw new Error("商品が別の画面で変更されました。編集を開き直してください。");
    const errors = validateInput(value, existing);
    if (Object.keys(errors).length) { const error = new Error("入力内容を確認してください。"); error.fields = errors; throw error; }
    const identityChanged = !existing || value.name !== existing.name.trim() || value.category !== existing.category;
    if (identityChanged && data.some((entry) => entry.id !== existing?.id && entry.category === value.category && normalizedName(entry.name) === normalizedName(value.name))) {
      const error = new Error("同じカテゴリに同じ商品名があります。"); error.fields = { name: error.message }; throw error;
    }
    const saved = existing ? { ...existing, ...value, name: value.name === existing.name.trim() ? existing.name : value.name } : value;
    const request = existing ? items.put(saved) : items.add(saved);
    if (existing && !shoppingTarget(saved)) checks.delete(existing.id);
    return request;
  });
}
async function updateQuantity(id, delta) {
  return mutateState(({ items, checks, data }) => {
    const item = data.find((entry) => entry.id === id);
    if (!item) throw new Error("商品が見つかりません。");
    if ((delta < 0 && item.quantity === 0) || (delta > 0 && item.quantity >= 9999)) return;
    const quantity = Math.max(0, item.quantity + delta);
    const updated = { ...item, quantity };
    items.put(updated);
    if (!shoppingTarget(updated)) checks.delete(id);
  });
}
async function deleteItem(id) {
  return mutateState(({ items, checks }) => { items.delete(id); checks.delete(id); });
}
async function setChecked(id, checked) {
  return mutateState(({ data, checks }) => {
    const item = data.find((entry) => entry.id === id);
    if (!item || !shoppingTarget(item)) { checks.delete(id); return; }
    if (checked) checks.put({ itemId: id }); else checks.delete(id);
  });
}

function visibleAnchor(root) {
  const cards = Array.from(root.querySelectorAll(".product-card"));
  const index = cards.findIndex((card) => card.getBoundingClientRect().bottom > 0);
  if (index < 0) return null;
  return cards.slice(index).map((card) => ({ id: Number(card.dataset.itemId), top: card.getBoundingClientRect().top }));
}
function keepPosition(root, render) {
  const anchor = root.closest(".screen")?.hidden ? null : visibleAnchor(root);
  const y = window.scrollY;
  render();
  if (anchor) {
    for (const previous of anchor) {
      const card = root.querySelector('[data-item-id="' + previous.id + '"]');
      if (card) { window.scrollBy(0, card.getBoundingClientRect().top - previous.top); return; }
    }
    window.scrollTo(0, y);
  }
}
function focusCard(id) {
  requestAnimationFrame(() => {
    const card = inventoryList.querySelector('[data-item-id="' + id + '"]');
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: "auto" });
    card.classList.add("card-highlight");
    setTimeout(() => card.classList.remove("card-highlight"), 2000);
  });
}
function categoryGroup(category, count, checked = null) {
  const section = document.createElement("section"); section.className = "category-group";
  section.style.setProperty("--category-color", category.color);
  const heading = document.createElement("h2"); heading.className = "category-heading";
  const dot = document.createElement("span"); dot.className = "category-dot"; dot.setAttribute("aria-hidden", "true");
  heading.append(dot, document.createTextNode(category.name + "（" + (checked === null ? count : checked + "/" + count) + "件）"));
  const list = document.createElement("div"); list.className = "category-items";
  section.append(heading, list); return { section, list };
}
function setProductText(card, item) {
  card.dataset.itemId = item.id;
  card.querySelector(".item-name").textContent = item.name;
  card.querySelector(".category").textContent = item.category;
  card.querySelector(".stock-label").textContent = "在庫 " + item.quantity + "個";
  card.querySelector(".reorder-label").textContent = "発注点 " + item.reorderPoint + "個";
}
function renderInventory(items = currentItems) {
  currentItems = items;
  keepPosition(inventoryList, () => {
    inventoryList.replaceChildren(); inventoryMessage.hidden = items.length > 0;
    inventoryMessage.textContent = "まだ商品はありません";
    for (const category of CATEGORY_CONFIG) {
      const groupItems = items.filter((item) => item.category === category.name).sort((a, b) => a.id - b.id);
      if (!groupItems.length) continue;
      const group = categoryGroup(category, groupItems.length);
      for (const item of groupItems) {
        const card = cardTemplate.content.firstElementChild.cloneNode(true); setProductText(card, item);
        card.querySelector(".shopping-target").hidden = !shoppingTarget(item);
        card.querySelector(".quantity-value").textContent = item.quantity;
        card.querySelector(".quantity-control").setAttribute("aria-label", item.name + "の在庫数量");
        for (const [selector, delta, label] of [[".decrease-button", -1, "減らす"], [".increase-button", 1, "増やす"]]) {
          const button = card.querySelector(selector); button.setAttribute("aria-label", item.name + "を1個" + label);
          button.addEventListener("click", () => changeQuantity(item.id, delta));
        }
        const more = card.querySelector(".card-more"), menu = card.querySelector(".card-delete-action");
        more.setAttribute("aria-label", item.name + "の操作");
        more.addEventListener("click", () => { menu.hidden = !menu.hidden; more.setAttribute("aria-expanded", String(!menu.hidden)); });
        card.querySelector(".card-edit").addEventListener("click", () => startEditing(item.id));
        card.querySelector(".card-delete").addEventListener("click", () => confirmItemDeletion(item.id));
        const error = card.querySelector(".card-error"); error.hidden = !cardErrors.has(item.id); error.textContent = cardErrors.get(item.id) || "";
        group.list.append(card);
      }
      inventoryList.append(group.section);
    }
  });
  syncControls();
}
function renderShoppingList(items = currentItems) {
  const target = items.filter(shoppingTarget);
  const done = target.filter((item) => checkedIds.has(item.id)).length;
  document.getElementById("shopping-progress").hidden = target.length === 0;
  document.getElementById("shopping-count").textContent = done + "／" + target.length + "件 チェック済み";
  document.getElementById("shopping-bar").max = target.length || 1;
  document.getElementById("shopping-bar").value = done;
  document.getElementById("shopping-complete").hidden = !target.length || done !== target.length;
  shoppingMessage.textContent = "現在、買い物が必要な商品はありません"; shoppingMessage.hidden = target.length > 0;
  keepPosition(shoppingList, () => {
    shoppingList.replaceChildren();
    for (const category of CATEGORY_CONFIG) {
      const groupItems = target.filter((item) => item.category === category.name)
        .sort((a, b) => Number(checkedIds.has(a.id)) - Number(checkedIds.has(b.id)) || a.id - b.id);
      if (!groupItems.length) continue;
      const group = categoryGroup(category, groupItems.length, groupItems.filter((item) => checkedIds.has(item.id)).length);
      for (const item of groupItems) {
        const card = shoppingCardTemplate.content.firstElementChild.cloneNode(true); setProductText(card, item);
        const checkbox = card.querySelector("input"); checkbox.checked = checkedIds.has(item.id);
        checkbox.setAttribute("aria-label", item.name + "をかごに入れた");
        checkbox.addEventListener("change", () => changeChecked(item.id, checkbox.checked));
        const error = card.querySelector(".check-error"); error.hidden = !checkErrors.has(item.id); error.textContent = checkErrors.get(item.id) || "";
        group.list.append(card);
      }
      shoppingList.append(group.section);
    }
  });
  syncControls();
}
function applyState(state) {
  currentItems = state.items;
  checkedIds = new Set(state.checks.filter((check) => state.items.some((item) => item.id === check.itemId && shoppingTarget(item))).map((check) => check.itemId));
  renderInventory(); renderShoppingList();
}
function changeQuantity(id, delta) {
  if (!appReady || isSaving || managementBusy) return Promise.resolve();
  return queueWrite(async () => {
    try { const state = await updateQuantity(id, delta); cardErrors.delete(id); applyState(state); }
    catch {
      cardErrors.set(id, "在庫を保存できませんでした。もう一度お試しください。");
      try { applyState(await readState()); } catch { renderInventory(); }
    }
  });
}
function changeChecked(id, checked) {
  if (!appReady || isSaving || managementBusy || pendingWrites) { renderShoppingList(); return Promise.resolve(); }
  // ネイティブチェックの先行表示を戻し、保存成功後に反映します。
  renderShoppingList();
  return queueWrite(async () => {
    try { const state = await setChecked(id, checked); checkErrors.delete(id); applyState(state); }
    catch {
      checkErrors.set(id, "チェックを保存できませんでした。もう一度お試しください。");
      try { applyState(await readState()); } catch { renderShoppingList(); }
    }
  });
}
function startEditing(id) {
  if (!appReady || pendingWrites || isSaving || managementBusy) return;
  const item = currentItems.find((entry) => entry.id === id); if (!item) return;
  editingItem = { ...item }; clearFormErrors();
  Object.keys(fields).forEach((key) => { fields[key].value = item[key]; });
  document.getElementById("add-title").textContent = "商品情報を編集";
  addButton.textContent = "変更を保存"; cancelEditButton.hidden = false;
  showScreen("add"); syncControls();
}
function confirmItemDeletion(id) {
  if (!appReady || pendingWrites || isSaving || managementBusy || !window.confirm("このカードを削除しますか")) return Promise.resolve();
  return queueWrite(async () => {
    try { const state = await deleteItem(id); cardErrors.delete(id); checkErrors.delete(id); applyState(state); }
    catch { cardErrors.set(id, "商品を削除できませんでした。商品は変更されていません。"); renderInventory(); }
  });
}
Object.values(fields).forEach((field) => field.addEventListener("input", () => { clearFormErrors(); syncControls(); }));
fields.category.addEventListener("change", () => { clearFormErrors(); syncControls(); });
cancelEditButton.addEventListener("click", () => { showScreen("inventory"); });
addButton.addEventListener("click", async (event) => {
  event.preventDefault(); if (!appReady || isSaving || pendingWrites || managementBusy || addButton.disabled) return;
  clearFormErrors(); const value = formValues(), original = editingItem;
  const errors = validateInput(value, original);
  if (Object.keys(errors).length) { Object.entries(errors).forEach(([key, message]) => displayFieldError(key, message)); return; }
  isSaving = true; syncControls(); addButton.textContent = "保存中…";
  let savedId;
  try {
    await queueWrite(async () => {
      const state = await persistItem(value, original);
      savedId = state.result.result; applyState(state);
    });
    resetForm();
  } catch (error) {
    if (error.fields) Object.entries(error.fields).forEach(([key, message]) => displayFieldError(key, message));
    else { formMessage.textContent = "保存できませんでした。入力内容は残っています。"; formMessage.hidden = false; }
  } finally {
    isSaving = false; addButton.textContent = editingItem ? "変更を保存" : "追加"; syncControls();
  }
  if (savedId !== undefined) { showScreen("inventory"); focusCard(savedId); }
});
form.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing && event.target.tagName === "INPUT") { event.preventDefault(); if (!addButton.disabled) addButton.click(); }
});

// バックアップ／復元。一時状態はメモリーだけに保持します。
const BACKUP_APP_ID = "home_inventory";
const BACKUP_FORMAT_VERSION = 1;
managementUI = {
  message: document.getElementById("data-message"),
  file: document.getElementById("backup-file"),
  export: document.getElementById("backup-export"),
  select: document.getElementById("restore-select"),
  confirm: document.getElementById("restore-confirm"),
  verify: document.getElementById("backup-verify"),
  finish: document.getElementById("restore-finish"),
  abort: document.getElementById("data-abort")
};

function dataMessage(message) {
  managementUI.message.textContent = message;
  managementUI.message.hidden = !message;
}

function renderDataActions() {
  const stage = managementState.stage;
  managementUI.export.hidden = stage !== "idle";
  managementUI.select.hidden = !["idle", "restoreSelect"].includes(stage);
  managementUI.confirm.hidden = stage !== "restoreReady";
  managementUI.verify.hidden = !["backupVerify", "beforeVerify"].includes(stage);
  managementUI.finish.hidden = stage !== "restoreVerified";
  managementUI.abort.hidden = stage === "idle";
  managementUI.abort.textContent = stage === "backupVerify" ? "バックアップ中断" : "復元中断";
  for (const key of ["export", "select", "confirm", "verify", "finish", "abort"]) {
    managementUI[key].disabled = managementBusy || !appReady || isSaving || pendingWrites > 0;
  }
  navButtons.forEach((button) => { button.disabled = managementBusy || isSaving || pendingWrites > 0; });
}

function resetDataManagement(message = "") {
  managementState = { stage: "idle", target: null, verifiedItems: null };
  managementUI.file.value = "";
  dataMessage(message);
  renderDataActions();
}

async function dataTask(task) {
  if (managementBusy) return;
  if (!appReady || isSaving || pendingWrites) {
    dataMessage("商品の保存処理が終わってから、もう一度お試しください。");
    return;
  }
  managementBusy = true;
  renderDataActions();
  try { await task(); }
  catch (error) { dataMessage(error.message || "処理に失敗しました。もう一度お試しください。"); }
  finally { managementBusy = false; renderDataActions(); }
}

// JSONで全フィールドを損失なく表現できるか確認します。
function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.prototype.toString.call(value) !== "[object Object]") return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Object.prototype.toString.call(a) !== "[object Object]" && !Array.isArray(a)) return false;
  if (Object.prototype.toString.call(b) !== "[object Object]" && !Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

function sameItems(a, b) {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((item) => [item.id, item]));
  return byId.size === b.length && new Set(a.map((item) => item.id)).size === a.length &&
    a.every((item) => byId.has(item.id) && deepEqual(item, byId.get(item.id)));
}

function validBackupTimestamp(value) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return false;
  // ISO日時の存在しない日付（2月30日など）をDate.parseの正規化で許可しません。
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (match) {
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > days) return false;
  }
  return true;
}

function validateBackup(data, allowEmpty = false) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.appId !== BACKUP_APP_ID) {
    throw new Error("このアプリのバックアップではありません。");
  }
  if (data.backupFormatVersion !== BACKUP_FORMAT_VERSION) throw new Error("非対応のバックアップ形式です。");
  if (!validBackupTimestamp(data.backupTimestamp)) throw new Error("バックアップ日時が不正です。");
  if (!Number.isSafeInteger(data.itemCount) || data.itemCount < 0 || !Array.isArray(data.items) || data.itemCount !== data.items.length) {
    throw new Error("商品数または商品配列が不正です。");
  }
  if (!allowEmpty && data.itemCount === 0) throw new Error("復元対象には1件以上の商品が必要です。");
  const ids = new Set();
  for (const item of data.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id) ||
        typeof item.name !== "string" || !item.name.trim() || !CATEGORIES.includes(item.category) ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 0 ||
        !Number.isSafeInteger(item.reorderPoint) || item.reorderPoint < 0 || !isJsonValue(item)) {
      throw new Error("不正な商品データが含まれています。バックアップ全体を拒否しました。");
    }
    ids.add(item.id);
  }
  return data;
}

function jstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function makeBackup(items, date = new Date()) {
  const p = jstParts(date);
  const data = { appId: BACKUP_APP_ID, backupFormatVersion: BACKUP_FORMAT_VERSION, appVersion: "1.0",
    backupTimestamp: p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute + ":" + p.second + "+09:00",
    itemCount: items.length, items };
  validateBackup(data, true);
  const json = JSON.stringify(data, null, 2);
  if (!sameItems(items, JSON.parse(json).items)) throw new Error("商品にJSONで保持できないデータがあります。書き出しを中止しました。");
  return { data, json, filename: "home_inventory_backup_" + p.year + p.month + p.day + "_" + p.hour + p.minute + p.second + ".json" };
}

function downloadBackup(backup) {
  const url = URL.createObjectURL(new Blob([backup.json], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = backup.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function backupSummary(data) {
  const p = jstParts(new Date(data.backupTimestamp));
  return "商品数：" + data.itemCount + "件\nバックアップ日時：" + p.year + "年" + Number(p.month) + "月" + Number(p.day) + "日 " + p.hour + ":" + p.minute + ":" + p.second + "（日本時間）";
}

async function exportBackup(beforeRestore) {
  const items = await readItems();
  if (!beforeRestore && items.length === 0) {
    dataMessage("バックアップする商品がありません。");
    return;
  }
  const backup = makeBackup(items);
  downloadBackup(backup);
  managementState.stage = beforeRestore ? "beforeVerify" : "backupVerify";
  managementState.verifiedItems = null;
  dataMessage("ファイル保存を開始しました。端末に保存した実際のJSONファイルを選び直してください。まだ確認済みではありません。" +
    (beforeRestore ? "\n復元すると現在の商品は、選択したバックアップの内容にすべて置き換わります。" : ""));
}

function chooseBackupFile() {
  managementUI.file.value = "";
  managementUI.file.click();
}

managementUI.export.addEventListener("click", () => dataTask(() => exportBackup(false)));
managementUI.select.addEventListener("click", () => {
  if (managementBusy || !appReady || pendingWrites || isSaving) return;
  managementState.stage = "restoreSelect";
  managementState.target = null;
  managementState.verifiedItems = null;
  dataMessage("復元対象のJSONファイルを選択してください。商品データはまだ変更されません。");
  renderDataActions();
  chooseBackupFile();
});
managementUI.confirm.addEventListener("click", () => dataTask(() => exportBackup(true)));
managementUI.verify.addEventListener("click", chooseBackupFile);
managementUI.abort.addEventListener("click", () => {
  if (managementBusy) return;
  const normal = managementState.stage === "backupVerify";
  resetDataManagement(normal ? "バックアップの確認を中断しました。商品データは変更されていません。" : "復元を中断しました。現在の商品データは変更されていません。");
});

managementUI.file.addEventListener("change", () => {
  const file = managementUI.file.files[0];
  if (!file) return;
  const stage = managementState.stage;
  if (!["restoreSelect", "backupVerify", "beforeVerify"].includes(stage)) return;
  return dataTask(async () => {
    dataMessage("ファイルを確認しています…");
    let data;
    try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
    catch { throw new Error("ファイルを読み込めないか、不正なJSONです。もう一度ファイルを選択してください。"); }
    validateBackup(data, stage === "beforeVerify");
    if (stage === "restoreSelect") {
      managementState.target = data;
      managementState.stage = "restoreReady";
      dataMessage(backupSummary(data) + "\nこのバックアップから復元しますか？次に現在のデータをバックアップして実物確認します。商品データはまだ変更されません。");
      return;
    }
    const items = await readItems();
    if (!sameItems(data.items, items)) throw new Error("現在の商品データと完全には一致しません。確認済みにはできません。正しいファイルを選び直してください。");
    if (stage === "beforeVerify") {
      managementState.verifiedItems = data.items;
      managementState.stage = "restoreVerified";
      dataMessage("✓ 復元前バックアップを確認しました\n" + backupSummary(data) + "\n現在の商品データと完全に一致しています。\n「保存完了」を押すと、選択済みバックアップで全商品を置き換えます。");
    } else {
      resetDataManagement("✓ バックアップを確認しました\n" + backupSummary(data) + "\n現在の商品データと完全に一致しています。");
    }
  });
});

// 最終確認の後だけ呼び出します。getAll→一致確認→clear→putを1トランザクション内で実施。
async function restoreItems(target, expectedItems) {
  validateBackup(target, false);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, CHECK_STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let reason;
    transaction.oncomplete = () => resolve();
    // abortイベントはロールバック完了後。成功前に「変更なし」を報告しません。
    transaction.onabort = () => reject(reason || transaction.error || new Error("復元に失敗しました。"));
    const current = store.getAll();
    current.onsuccess = () => {
      try {
        if (!sameItems(current.result, expectedItems)) {
          reason = new Error("確認後に商品データが変わりました。復元前バックアップの書き出しと実物確認をやり直してください。");
          transaction.abort();
          return;
        }
        store.clear();
        transaction.objectStore(CHECK_STORE_NAME).clear();
        // ここでawaitしない。IDを維持し、失敗したリクエストはデフォルト動作で全体をabort。
        target.items.forEach((item) => store.put(item));
      } catch (error) {
        reason = error;
        transaction.abort();
      }
    };
  });
}

managementUI.finish.addEventListener("click", () => dataTask(async () => {
  if (managementState.stage !== "restoreVerified" || !managementState.target || !managementState.verifiedItems) return;
  const target = managementState.target;
  dataMessage("復元しています…");
  try {
    await restoreItems(target, managementState.verifiedItems);
  } catch (error) {
    managementState.stage = "restoreReady";
    managementState.verifiedItems = null;
    dataMessage("復元に失敗しました。現在の商品データは変更されていません。\n" + error.message);
    return;
  }
  // DBコミットと表示処理を区別。表示失敗をロールバック成功と誤表示しません。
  resetDataManagement(target.items.length + "件の商品を復元しました。");
  cardErrors.clear(); checkErrors.clear();
  try {
    applyState(await readState());
  } catch {
    dataMessage(target.items.length + "件の商品を復元しました。画面の更新に失敗したため、再読み込みしてください。");
  }
}));
renderDataActions();


// すべてのイベント登録後に読込。失敗時は書き込みを許可しません。
async function initializeApp() {
  try {
    fields.category.replaceChildren();
    CATEGORY_CONFIG.forEach((category) => { const option = document.createElement("option"); option.value = category.name; option.textContent = category.name; fields.category.append(option); });
    resetForm(); applyState(await readState()); appReady = true; syncControls(); renderDataActions();
  } catch {
    appReady = false; syncControls();
    inventoryMessage.hidden = false; inventoryMessage.textContent = "データを読み込めませんでした。他のタブを閉じて再読み込みしてください。";
    shoppingMessage.hidden = false; shoppingMessage.textContent = "データを読み込めませんでした。再読み込みしてください。";
    formMessage.hidden = false; formMessage.textContent = "初期化できませんでした。再読み込みしてください。";
    renderDataActions();
  }
}
showScreen("inventory");
initializeApp();
