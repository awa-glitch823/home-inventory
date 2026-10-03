"use strict";

// 商品の正データはIndexedDBに保存し、保存完了後に画面を更新します。
const screens = document.querySelectorAll(".screen");
const navButtons = document.querySelectorAll(".nav-button");
let managementUI = null;
let managementBusy = false;
let managementState = { stage: "idle", target: null, verifiedItems: null };

function showScreen(screenId) {
  if (!document.getElementById(screenId)?.classList.contains("screen")) return;
  if (managementBusy) return;
  if (screenId !== "settings" && managementUI) resetDataManagement();

  screens.forEach((screen) => {
    screen.hidden = screen.id !== screenId;
  });

  navButtons.forEach((button) => {
    const isActive = button.dataset.screen === screenId;
    button.classList.toggle("is-active", isActive);
    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  window.scrollTo(0, 0);
}

navButtons.forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.screen));
});

showScreen("inventory");

const DB_NAME = "homeInventoryDB";
const STORE_NAME = "items";
const CATEGORIES = ["トイレ", "洗面所", "お風呂", "キッチン", "洗濯", "掃除", "その他"];
const form = document.getElementById("add-form");
const addButton = form.querySelector(".add-button");
const formMessage = document.getElementById("form-message");
const inventoryMessage = document.getElementById("inventory-message");
const inventoryList = document.getElementById("inventory-list");
const cardTemplate = document.getElementById("inventory-card-template");
const shoppingList = document.getElementById("shopping-list");
const shoppingMessage = document.getElementById("shopping-message");
const shoppingCardTemplate = document.getElementById("shopping-card-template");
let currentItems = [];
let databasePromise;
let isSaving = false;
const quantityUpdates = new Map();

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDBを利用できません。"));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // DBが一意の連番idを採番します。将来、項目を追加できます。
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      db.onclose = () => { databasePromise = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("他のタブを閉じて再読み込みしてください。"));
    };
  }).catch((error) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

async function readItems() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error("読み込みに失敗しました。"));
    transaction.onerror = () => reject(transaction.error || request.error);
  });
}

async function saveItem(item) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).add(item);
    // リクエスト成功だけでなく、保存トランザクション完了を待ちます。
    transaction.oncomplete = () => resolve({ ...item, id: request.result });
    transaction.onabort = () => reject(transaction.error || new Error("保存に失敗しました。"));
    transaction.onerror = () => reject(transaction.error || request.error);
  });
}

// 最新数量の取得と更新を同じトランザクションで行い、他の商品は変更しません。
async function updateQuantity(id, delta) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    let updatedItem;
    let validationError;
    request.onsuccess = () => {
      const item = request.result;
      if (!item || !Number.isSafeInteger(item.quantity) || item.quantity < 0) {
        validationError = new Error("商品の在庫データを確認できませんでした。");
        transaction.abort();
        return;
      }
      const quantity = Math.max(0, item.quantity + delta);
      if (!Number.isSafeInteger(quantity)) {
        validationError = new Error("在庫数量が上限に達しています。");
        transaction.abort();
        return;
      }
      updatedItem = { ...item, quantity };
      store.put(updatedItem);
    };
    transaction.oncomplete = () => resolve(updatedItem);
    transaction.onabort = () => reject(validationError || transaction.error || new Error("在庫を保存できませんでした。"));
    transaction.onerror = () => reject(transaction.error || new Error("在庫を保存できませんでした。"));
  });
}

function changeQuantity(id, delta) {
  // 同じ商品の連続タップも順番に処理し、表示の逆転を防ぎます。
  const previous = quantityUpdates.get(id) || Promise.resolve();
  const pending = previous.then(async () => {
    try {
      const item = await updateQuantity(id, delta);
      // 保存中にカードが再生成されても、現在の対象カードだけを更新します。
      const card = Array.from(inventoryList.children).find((element) => Number(element.dataset.itemId) === id);
      if (card) {
        card.querySelector(".stock-label").textContent = `在庫 ${item.quantity}個`;
        card.querySelector(".quantity-value").textContent = item.quantity;
      }
      inventoryMessage.hidden = true;
      currentItems = currentItems.map((existing) => existing.id === item.id ? item : existing);
      renderShoppingList(currentItems);
    } catch (error) {
      inventoryMessage.textContent = "在庫を保存できませんでした。数量は変更していません。もう一度お試しください。";
      inventoryMessage.hidden = false;
    }
  });
  quantityUpdates.set(id, pending);
  pending.then(() => {
    if (quantityUpdates.get(id) === pending) quantityUpdates.delete(id);
  });
  return pending;
}

function renderInventory(items) {
  currentItems = items;
  inventoryList.replaceChildren();
  inventoryMessage.textContent = "まだ商品はありません";
  inventoryMessage.hidden = items.length > 0;
  items.forEach((item) => {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.itemId = item.id;
    // 入力をHTMLとして解釈させず、文字として安全に表示します。
    card.querySelector("h2").textContent = item.name;
    card.querySelector(".category").textContent = item.category;
    card.querySelector(".stock-label").textContent = `在庫 ${item.quantity}個`;
    card.querySelector(".reorder-label").textContent = `発注点 ${item.reorderPoint}個`;
    card.querySelector(".quantity-value").textContent = item.quantity;
    card.querySelector(".quantity-control").setAttribute("aria-label", `${item.name}の在庫数量`);
    card.querySelector(".decrease-button").setAttribute("aria-label", `${item.name}を1個減らす`);
    card.querySelector(".increase-button").setAttribute("aria-label", `${item.name}を1個増やす`);
    card.querySelector(".decrease-button").addEventListener("click", () => changeQuantity(item.id, -1));
    card.querySelector(".increase-button").addEventListener("click", () => changeQuantity(item.id, 1));
    inventoryList.append(card);
  });
  renderShoppingList(items);
}

// 買い物リストはitemsの表示結果。専用データやチェック状態は保存しません。
function renderShoppingList(items) {
  // 同じページ内の再描画では、表示中の商品だけチェックを引き継ぎます。
  const checkedIds = new Set(Array.from(shoppingList.children)
    .filter((card) => card.querySelector("input").checked)
    .map((card) => Number(card.dataset.itemId)));
  const shoppingItems = items.filter((item) => item.quantity <= item.reorderPoint);
  shoppingList.replaceChildren();
  shoppingMessage.textContent = "買い物リストはまだありません";
  shoppingMessage.hidden = shoppingItems.length > 0;
  shoppingItems.forEach((item) => {
    const card = shoppingCardTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.itemId = item.id;
    card.querySelector("h2").textContent = item.name;
    card.querySelector(".category").textContent = item.category;
    card.querySelector(".stock-label").textContent = `在庫 ${item.quantity}個`;
    card.querySelector(".reorder-label").textContent = `発注点 ${item.reorderPoint}個`;
    const checkbox = card.querySelector("input");
    checkbox.setAttribute("aria-label", `${item.name}をかごに入れた`);
    checkbox.checked = checkedIds.has(item.id);
    // チェックのオン／オフはブラウザー標準動作のみ。数量変更処理なし。
    shoppingList.append(card);
  });
}

function readFormItem() {
  const name = document.getElementById("product-name").value.trim();
  const category = document.getElementById("product-category").value;
  const stockText = document.getElementById("initial-stock").value.trim();
  const pointText = document.getElementById("reorder-point").value.trim();
  const quantity = Number(stockText);
  const reorderPoint = Number(pointText);
  if (!name) throw new Error("商品名を入力してください。");
  if (!CATEGORIES.includes(category)) throw new Error("定義済みのカテゴリを選択してください。");
  if (!stockText || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error("在庫は0以上の整数を入力してください。");
  }
  if (!pointText || !Number.isSafeInteger(reorderPoint) || reorderPoint < 0) {
    throw new Error("発注点は0以上の整数を入力してください。");
  }
  return { name, category, quantity, reorderPoint };
}

// HTMLのform要素を使わず、ブラウザー標準の送信経路をなくしています。
addButton.addEventListener("click", async (event) => {
  event.preventDefault();
  if (isSaving || addButton.disabled) return;
  formMessage.hidden = true;
  let item;
  try {
    item = readFormItem();
  } catch (error) {
    formMessage.textContent = error.message;
    formMessage.hidden = false;
    return;
  }
  isSaving = true;
  addButton.disabled = true;
  addButton.textContent = "保存中…";
  try {
    // 最新の保存データを取得。失敗時には登録を開始しません。
    const items = await readItems();
    const savedItem = await saveItem(item);
    renderInventory([...items, savedItem]);
    document.getElementById("product-name").value = "";
    document.getElementById("product-category").selectedIndex = 0;
    document.getElementById("initial-stock").value = "0";
    document.getElementById("reorder-point").value = "0";
    showScreen("inventory");
  } catch (error) {
    formMessage.textContent = "保存できませんでした。入力内容は残っています。ブラウザーの保存設定を確認して、もう一度お試しください。";
    formMessage.hidden = false;
  } finally {
    isSaving = false;
    addButton.disabled = false;
    addButton.textContent = "追加";
  }
});

form.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing && event.target.tagName === "INPUT") {
    event.preventDefault();
    if (!addButton.disabled) addButton.click();
  }
});

async function initializeInventory() {
  try {
    renderInventory(await readItems());
    return true;
  } catch (error) {
    inventoryMessage.hidden = false;
    inventoryMessage.textContent = "在庫を読み込めませんでした。他のタブやブラウザーの保存設定を確認し、再読み込みしてください。";
    shoppingMessage.hidden = false;
    shoppingMessage.textContent = "買い物リストを読み込めませんでした。再読み込みしてください。";
    formMessage.textContent = "初期化できませんでした。再読み込みしてください。";
    formMessage.hidden = false;
    return false;
  }
}

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
    managementUI[key].disabled = managementBusy;
  }
  navButtons.forEach((button) => { button.disabled = managementBusy; });
}

function resetDataManagement(message = "") {
  managementState = { stage: "idle", target: null, verifiedItems: null };
  managementUI.file.value = "";
  dataMessage(message);
  renderDataActions();
}

async function dataTask(task) {
  if (managementBusy) return;
  if (isSaving || quantityUpdates.size) {
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
  if (managementBusy) return;
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
    const transaction = db.transaction(STORE_NAME, "readwrite");
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
  try {
    shoppingList.replaceChildren();
    renderInventory(await readItems());
  } catch {
    dataMessage(target.items.length + "件の商品を復元しました。画面の更新に失敗したため、再読み込みしてください。");
  }
}));
renderDataActions();

// 全イベント登録とIndexedDB読み込みが完了した場合だけ入力を許可します。
initializeInventory().then((initialized) => {
  if (!initialized) return;
  form.querySelectorAll("input, select").forEach((control) => { control.disabled = false; });
  addButton.disabled = false;
});
