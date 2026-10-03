(function () {
  "use strict";


  const CONFIG = {
    labelText: "Collection", // Name the label, for e.g. Set or Collection

    enablePhraseParser: false,

    phraseParser: [
      { from: "Filmreihe", to: "Collection" } // Convert TMDb set indicator names from their localized language to another term, for e.g., "Saga", "Filmreihe", or "Colección" to "Collection"
    ],

    position: "top", // "top", "after", or "end"

    afterLabel: "Studio", // Used only if position is "after"
    // "Genres"
    // "Director"
    // "Writer"
    // "Studio"
    // "Country"    (DetailsGroupItemsExtended script installed & enabled only)
    // "Awards"     (DetailsGroupItemsExtended script installed & enabled only)
    // "Box Office" (DetailsGroupItemsExtended script installed & enabled only)

    debug: false
  };

  function parseCollectionName(name) {
    let out = String(name || "");

    if (!CONFIG.enablePhraseParser) {
      return out.trim();
    }

    for (const rule of CONFIG.phraseParser || []) {
      if (!rule || !rule.from) continue;
      // split/join instead of replaceAll (Chrome 85+)
      out = out.split(String(rule.from)).join(String(rule.to || ""));
    }

    return out.trim();
  }

  const SETTINGS = {
    rowKey: "collection",
    clickable: true,
    cacheTtlMs: 1000 * 60 * 30,
    // After a failed request: wait this long before asking again.
    retryAfterMs: 1000 * 30,
    debug: CONFIG.debug
  };

  function log(...args) {
    if (SETTINGS.debug) console.log("[CollectionInject]", ...args);
  }

  function getApiClient() {
    return window.ApiClient || null;
  }

  // Server address of the running web client, incl. a base URL such as
  // "/jellyfin" (window.ApiClient: 10.10.x components/ServerConnections.js:88,
  // 12.x lib/jellyfin-apiclient/ServerConnections.js:95). Same as the page
  // origin on a server without a base URL.
  function getBaseUrl() {
    try {
      const api = getApiClient();
      const addr = api && typeof api.serverAddress === "function" && api.serverAddress();
      if (addr) return String(addr).replace(/\/+$/, "");
    } catch (e) { /* ignore */ }
    return window.location.origin;
  }

  function getUrlParams() {
    const hash = window.location.hash || "";
    const query = hash.includes("?")
      ? hash.split("?")[1]
      : window.location.search.slice(1);

    const params = new URLSearchParams(query);

    return {
      itemId: params.get("id"),
      serverId: params.get("serverId")
    };
  }

  function getServerId() {
    try {
      const api = getApiClient();
      const id = api && typeof api.serverId === "function" && api.serverId();
      if (id) return String(id);
    } catch (e) { /* ignore */ }
    return "";
  }

  // Saved credentials of the server this page is connected to; the first
  // entry with a token only when the current server is not known (as before).
  function getCredentialsServer() {
    try {
      const raw = localStorage.getItem("jellyfin_credentials");
      if (!raw) return null;

      const obj = JSON.parse(raw);
      const servers = (obj && obj.Servers) || [];
      const serverId = getServerId();
      return (
        (serverId && servers.find((s) => s.Id === serverId && s.AccessToken)) ||
        servers.find((s) => s.AccessToken) ||
        null
      );
    } catch (e) {
      return null;
    }
  }

  // Token of the current server: ApiClient first, saved credentials as fallback.
  function getAccessToken() {
    try {
      const api = getApiClient();
      const t = api && typeof api.accessToken === "function" && api.accessToken();
      if (t) return t;
    } catch (e) { /* ignore */ }
    const server = getCredentialsServer();
    return (server && server.AccessToken) || null;
  }

  function getUserId() {
    try {
      const api = getApiClient();
      if (api && api.getCurrentUserId) {
        const id = api.getCurrentUserId();
        if (id) return id;
      }
    } catch (e) { /* ignore */ }

    const server = getCredentialsServer();
    return (server && server.UserId) || null;
  }

  function cacheGet(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;

      const obj = JSON.parse(raw);
      if (Date.now() > obj.expires) return null;

      return obj.value;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, value) {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          value,
          expires: Date.now() + SETTINGS.cacheTtlMs
        })
      );
    } catch (e) { /* ignore */ }
  }

  // { ok, status, data } - or null without a token.
  async function apiRequest(path, params = {}) {
    const token = getAccessToken();
    if (!token) {
      log("No Jellyfin token found");
      return null;
    }

    const url = new URL(`${getBaseUrl()}/${path}`);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    }

    // Authorization header: Jellyfin 12.x ignores X-Emby-Token unless legacy
    // authorization is switched on; this form works in 10.10.x and 12.x.
    const res = await fetch(url.toString(), {
      headers: { Authorization: `MediaBrowser Token="${token}"` }
    });

    if (!res.ok) {
      log("API failed:", res.status, url.toString());
      return { ok: false, status: res.status, data: null };
    }

    return { ok: true, status: res.status, data: await res.json() };
  }

  async function apiGet(path, params = {}) {
    const r = await apiRequest(path, params);
    return r && r.ok ? r.data : null;
  }

  function findDetailsBox() {
    return document.querySelector(".itemDetailsGroup");
  }

  function removeRow(box) {
    if (!box) return;

    const row = box.querySelector(`[data-collection-row="${SETTINGS.rowKey}"]`);
    if (row) row.remove();
  }

  function normalizeLabelText(text) {
    return String(text || "")
      .replace(/:$/, "")
      .trim()
      .toLowerCase();
  }

  // The row's own place in the box: 10.10.x rows are direct children; 12.x
  // wraps each native row in a React root div (itemDetails/index.js 12.x:
  // 1007-1021) - we insert after that wrapper, never inside it.
  function toBoxChild(box, el) {
    while (el && el.parentElement && el.parentElement !== box) el = el.parentElement;
    return el && el.parentElement === box ? el : null;
  }

  // afterLabel without the language: 10.10.x native rows carry a class per
  // kind (itemDetails/index.html 10.10.x:127-147); 12.x renders one wrapper
  // per kind in a fixed order (itemDetails/index.js 12.x:1009-1016);
  // DetailsGroupItems-Extended rows carry data-omdb-row.
  const LABEL_KINDS = {
    genre: { cls: "genresGroup", order12: 5 },
    director: { cls: "directorsGroup", order12: 2 },
    writer: { cls: "writersGroup", order12: 3 },
    studio: { cls: "studiosGroup", order12: 4 },
    country: { omdb: "country" },
    awards: { omdb: "awards" },
    award: { omdb: "awards" },
    "box office": { omdb: "boxoffice" }
  };

  function singular(text) {
    return text.length > 3 && text.endsWith("s") ? text.slice(0, -1) : text;
  }

  function isOwnRow(el) {
    return !!(el.dataset && (el.dataset.collectionRow || el.dataset.omdbRow));
  }

  function findRowByLabel(box, labelText) {
    const wanted = normalizeLabelText(labelText);
    if (!wanted) return null;

    const labels = Array.from(box.querySelectorAll(".detailsGroupItem .label, .label"));

    // 1) exact text (as before)
    for (const label of labels) {
      if (normalizeLabelText(label.textContent) === wanted) {
        return label.closest(".detailsGroupItem");
      }
    }

    // 2) singular/plural: "Studio" also finds "Studios" (several studios)
    const stem = singular(wanted);
    for (const label of labels) {
      if (singular(normalizeLabelText(label.textContent)) === stem) {
        return label.closest(".detailsGroupItem");
      }
    }

    // 3) by kind, whatever the UI language
    const own = (k) => Object.prototype.hasOwnProperty.call(LABEL_KINDS, k);
    const kind = own(wanted) ? LABEL_KINDS[wanted] : own(stem) ? LABEL_KINDS[stem] : null;
    if (!kind) return null;

    if (kind.omdb) {
      return box.querySelector(`[data-omdb-row="${kind.omdb}"]`);
    }

    const classic = box.querySelector(`.detailsGroupItem.${kind.cls}`);
    if (classic) return classic.classList.contains("hide") ? null : classic;

    const wrappers = Array.from(box.children).filter(
      (el) => !isOwnRow(el) && !el.classList.contains("detailsGroupItem")
    );
    if (wrappers.length === 6) {
      const wrapper = wrappers[kind.order12];
      if (wrapper && wrapper.querySelector(".detailsGroupItem")) return wrapper;
    }

    return null;
  }

  // Where the row belongs: { after: element } or { end: true } or { top: true }.
  function getConfiguredPlace(box) {
    const position = String(CONFIG.position || "top").toLowerCase();

    if (position === "end") return { end: true };

    if (position === "after") {
      const targetRow = findRowByLabel(box, CONFIG.afterLabel);
      const anchor = targetRow ? toBoxChild(box, targetRow) : null;
      return anchor ? { after: anchor } : { end: true };
    }

    return { top: true };
  }

  function insertRowByConfiguredPosition(box, row) {
    const place = getConfiguredPlace(box);

    if (place.after) {
      place.after.insertAdjacentElement("afterend", row);
      return;
    }

    if (place.end) {
      box.appendChild(row);
      return;
    }

    box.prepend(row);
  }

  // "after"/"end" are re-checked: DetailsGroupItems-Extended appends its
  // rows after ours when it (re)builds them. "top" stays unchecked (as before).
  function isAtConfiguredPlace(box, row) {
    const place = getConfiguredPlace(box);
    if (place.after) return row.previousElementSibling === place.after;
    if (place.end) return row === box.lastElementChild;
    return true;
  }

  async function fetchItem(itemId) {
    return apiGet(`Items/${encodeURIComponent(itemId)}`);
  }

  async function fetchUserItems(params = {}) {
    const userId = getUserId();

    if (userId) {
      return apiGet(`Users/${encodeURIComponent(userId)}/Items`, params);
    }

    return apiGet("Items", params);
  }

  // Index and its cache belong to one user on one server (another user in
  // the same tab must not see the previous user's collections).
  function getIndexScope() {
    return `${getServerId()}:${getUserId() || ""}`;
  }

  async function buildCollectionIndex(scope) {
    const cacheKey = "collectioninject_index_v9:" + scope;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const index = {};

    const boxSetsResult = await fetchUserItems({
      Recursive: "true",
      IncludeItemTypes: "BoxSet",
      Fields: "ProviderIds",
      Limit: "10000"
    });

    // A failed call is a failure, not "no collections" (retried later).
    if (!boxSetsResult) throw new Error("BoxSet list not available");

    const boxSets = boxSetsResult.Items || [];
    log("BoxSets found:", boxSets.length);

    for (const boxSet of boxSets) {
      const childrenResult = await fetchUserItems({
        ParentId: boxSet.Id,
        Recursive: "true",
        Limit: "10000"
      });

      const children = (childrenResult && childrenResult.Items) || [];

      for (const child of children) {
        if (!child || !child.Id) continue;

        if (!index[child.Id]) index[child.Id] = [];

        index[child.Id].push({
          Id: boxSet.Id,
          Name: boxSet.Name,
          Type: boxSet.Type
        });
      }
    }

    if (boxSets.length) cacheSet(cacheKey, index);
    return index;
  }

  function applyLinkStyling(a, enabled) {
    a.style.pointerEvents = enabled ? "auto" : "none";
    a.style.fontWeight = "600";
    a.style.color = "inherit";
    a.style.textDecoration = "none";
    a.style.cursor = enabled ? "pointer" : "default";
    a.style.display = "inline";
    a.style.whiteSpace = "normal";
    a.style.overflowWrap = "anywhere";
    a.style.wordBreak = "break-word";
    a.style.lineHeight = "1.2";
    a.style.padding = "0";
    a.style.margin = "0";

    if (!enabled) {
      a.removeAttribute("href");
      return;
    }

    if (!a.dataset.collectionHoverUnderlineBound) {
      a.addEventListener("mouseenter", () => {
        a.style.textDecoration = "underline";
      });

      a.addEventListener("mouseleave", () => {
        a.style.textDecoration = "none";
      });

      a.dataset.collectionHoverUnderlineBound = "true";
    }
  }

  function createCollectionLink(collection, serverId) {
    const a = document.createElement("a");
    a.className = "button-link emby-button";
    a.textContent = parseCollectionName(collection.Name || "Collection");

    if (SETTINGS.clickable && collection.Id) {
      // '#/details' directly: the '#!' form only reached it through a
      // redirect that 12.x marks as deprecated.
      const hash =
        `/details?id=${encodeURIComponent(collection.Id)}` +
        (serverId ? `&serverId=${encodeURIComponent(serverId)}` : "");

      a.href = `#${hash}`;

      a.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = hash;
      });
    }

    applyLinkStyling(a, SETTINGS.clickable && !!collection.Id);
    return a;
  }

  // Text metrics of Jellyfin's own row labels in this box: a plain div in
  // 10.10.x (same values as ours, so nothing changes there), an MUI
  // Typography <p> in 12.x (body1: own font size, line height 1.5, letter
  // spacing 0.00938em; components/itemDetails/ItemDetailsMetadataList.tsx:30).
  // Without the line height our rows sat 2px lower than the native ones; the
  // other values keep the label text itself identical (as E-A7 in Extended).
  const LABEL_METRICS = ["lineHeight", "fontSize", "letterSpacing", "fontWeight", "fontFamily"];
  function matchNativeLabel(box, label) {
    const native = box && box.querySelector(
      ".detailsGroupItem:not([data-omdb-row]):not([data-collection-row]) .label"
    );
    if (!native) return;
    const cs = getComputedStyle(native);
    LABEL_METRICS.forEach((prop) => {
      if (cs[prop]) label.style[prop] = cs[prop];
    });
  }

  function injectCollectionRow(box, collections, serverId) {
    removeRow(box);

    if (!collections || !collections.length) {
      log("Movie is not part of a collection");
      return;
    }

    const row = document.createElement("div");
    row.className = "detailsGroupItem";
    row.dataset.collectionRow = SETTINGS.rowKey;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = CONFIG.labelText;
    matchNativeLabel(box, label);

    const content = document.createElement("div");
    content.className = "content focuscontainer-x";

    collections.forEach((collection, index) => {
      if (index > 0) content.appendChild(document.createTextNode(", "));
      content.appendChild(createCollectionLink(collection, serverId));
    });

    row.appendChild(label);
    row.appendChild(content);

    insertRowByConfiguredPosition(box, row);

    log("Injected collection:", collections);
  }

  const STATE = {
    currentItemId: null,
    currentServerId: null,
    currentItem: null,
    currentCollections: null,
    currentCollectionsText: "",
    itemPromises: new Map(),
    itemCache: new Map(),
    itemFailedAt: new Map(),
    collectionPromises: new Map(),
    collectionsFailedAt: new Map(),
    noCollectionsEndpoint: {},
    indexPromise: null,
    indexScope: "",
    indexBuiltAt: 0,
    indexFailedAt: 0,
    runToken: 0,
    lastScanAt: 0
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findDetailsBoxes() {
    return Array.from(document.querySelectorAll(".itemDetailsGroup"))
      .filter(isVisible);
  }

  function findBestDetailsBox() {
    const boxes = findDetailsBoxes();
    if (!boxes.length) return null;
    return boxes[boxes.length - 1];
  }

  function hasCorrectCollectionRow(box) {
    const row = box && box.querySelector(`[data-collection-row="${SETTINGS.rowKey}"]`);
    if (!row) return false;
    return row.dataset.collectionForItemId === String(STATE.currentItemId || "") &&
      row.dataset.collectionNames === String(STATE.currentCollectionsText || "") &&
      isAtConfiguredPlace(box, row);
  }

  function markCollectionRow(box) {
    const row = box && box.querySelector(`[data-collection-row="${SETTINGS.rowKey}"]`);
    if (!row) return;
    row.dataset.collectionForItemId = String(STATE.currentItemId || "");
    row.dataset.collectionNames = String(STATE.currentCollectionsText || "");
  }

  function needsInjection(box) {
    if (!box) return false;
    if (!STATE.currentItemId) return false;
    if (!STATE.currentCollections || !STATE.currentCollections.length) return false;
    return !hasCorrectCollectionRow(box);
  }

  // Recently shown items (5 min, at most 20): going back to a page puts its
  // row back without a server round trip. A failed request waits retryAfterMs
  // (before, it was repeated every 750 ms).
  const ITEM_CACHE_MS = 1000 * 60 * 5;

  async function fetchItemCached(itemId) {
    if (!itemId) return null;

    const key = String(itemId);
    if (STATE.currentItemId === key && STATE.currentItem) return STATE.currentItem;
    const hit = STATE.itemCache.get(key);
    if (hit && Date.now() - hit.t < ITEM_CACHE_MS) return hit.item;
    const failedAt = STATE.itemFailedAt.get(key);
    if (failedAt && Date.now() - failedAt < SETTINGS.retryAfterMs) return null;
    if (STATE.itemPromises.has(key)) return STATE.itemPromises.get(key);

    const promise = fetchItem(key)
      .catch(() => null)
      .then((item) => {
        if (item) {
          STATE.itemFailedAt.delete(key);
          STATE.itemCache.delete(key);
          STATE.itemCache.set(key, { t: Date.now(), item });
          if (STATE.itemCache.size > 20) STATE.itemCache.delete(STATE.itemCache.keys().next().value);
        } else if (getAccessToken()) {
          // (no token yet = not logged in: try again with the next scan)
          STATE.itemFailedAt.set(key, Date.now());
        }
        return item;
      })
      .finally(() => STATE.itemPromises.delete(key));
    STATE.itemPromises.set(key, promise);
    return promise;
  }

  // The index is built once per user and server and kept for cacheTtlMs.
  // A failed build is not repeated for retryAfterMs (before, a network error
  // restarted the whole 1 + N build every 750 ms). Resolves to null then.
  async function getCollectionIndexStable() {
    const scope = getIndexScope();
    const now = Date.now();

    if (STATE.indexScope !== scope ||
        (STATE.indexBuiltAt && now - STATE.indexBuiltAt > SETTINGS.cacheTtlMs)) {
      STATE.indexPromise = null;
      STATE.indexBuiltAt = 0;
      STATE.indexFailedAt = 0;
      STATE.indexScope = scope;
    }

    if (!STATE.indexPromise) {
      if (STATE.indexFailedAt && now - STATE.indexFailedAt < SETTINGS.retryAfterMs) return null;
      STATE.indexPromise = buildCollectionIndex(scope).then((index) => {
        if (STATE.indexScope === scope) STATE.indexBuiltAt = Date.now();
        return index;
      }, (err) => {
        log("Collection index failed:", err);
        if (STATE.indexScope === scope) {
          STATE.indexPromise = null;
          STATE.indexFailedAt = Date.now();
        }
        return null;
      });
    }
    return STATE.indexPromise;
  }

  // 12.x answers GET /Items/{id}/Collections (LibraryController.cs 12.x:735,
  // used by itemDetails/index.js 12.x:1198-1203): one request, always fresh.
  // 10.10.x does not have it (404): then the index is used, and the endpoint
  // is not asked again on this server in this tab. Chosen by the answer, not
  // by the version number.
  function noCollectionsEndpointKey() {
    return "collectioninject_noItemCollections:" + getServerId();
  }

  function hasCollectionsEndpoint() {
    if (STATE.noCollectionsEndpoint[noCollectionsEndpointKey()]) return false;
    try {
      return sessionStorage.getItem(noCollectionsEndpointKey()) !== "1";
    } catch (e) {
      return true;
    }
  }

  function markNoCollectionsEndpoint() {
    STATE.noCollectionsEndpoint[noCollectionsEndpointKey()] = true;
    try {
      sessionStorage.setItem(noCollectionsEndpointKey(), "1");
    } catch (e) { /* ignore */ }
  }

  async function lookupCollections(itemId) {
    if (hasCollectionsEndpoint()) {
      const r = await apiRequest(`Items/${encodeURIComponent(itemId)}/Collections`, {
        userId: getUserId() || ""
      });
      if (!r) return null;
      if (r.ok) {
        const items = (r.data && r.data.Items) || [];
        return items.map((c) => ({ Id: c.Id, Name: c.Name, Type: c.Type }));
      }
      if (r.status !== 404 && r.status !== 405) return null;
      markNoCollectionsEndpoint();
    }

    const index = await getCollectionIndexStable();
    if (!index) return null;
    return index[itemId] || [];
  }

  // Collections of one item: [] = none, null = not known now (failed; asked
  // again after retryAfterMs).
  async function getCollectionsForItem(itemId) {
    const key = String(itemId);
    const failedAt = STATE.collectionsFailedAt.get(key);
    if (failedAt && Date.now() - failedAt < SETTINGS.retryAfterMs) return null;
    if (STATE.collectionPromises.has(key)) return STATE.collectionPromises.get(key);

    const promise = lookupCollections(key)
      .catch(() => null)
      .then((collections) => {
        if (collections) STATE.collectionsFailedAt.delete(key);
        else STATE.collectionsFailedAt.set(key, Date.now());
        return collections;
      })
      .finally(() => STATE.collectionPromises.delete(key));
    STATE.collectionPromises.set(key, promise);
    return promise;
  }

  async function prepareStateForCurrentRoute() {
    const { itemId, serverId } = getUrlParams();

    if (!itemId) {
      STATE.currentItemId = null;
      STATE.currentServerId = null;
      STATE.currentItem = null;
      STATE.currentCollections = null;
      STATE.currentCollectionsText = "";
      return false;
    }

    if (STATE.currentItemId !== itemId) {
      STATE.currentItemId = itemId;
      STATE.currentServerId = serverId;
      STATE.currentItem = null;
      STATE.currentCollections = null;
      STATE.currentCollectionsText = "";
    } else {
      STATE.currentServerId = serverId;
    }

    const item = await fetchItemCached(itemId);
    if (STATE.currentItemId !== itemId) return false;

    STATE.currentItem = item;
    log("Current item:", item && item.Name, item && item.Type);

    if (!item || item.Type !== "Movie") {
      for (const box of findDetailsBoxes()) removeRow(box);
      STATE.currentCollections = [];
      STATE.currentCollectionsText = "";
      return false;
    }

    // Looked up once per visit of the item (the scans in between reuse it).
    if (STATE.currentCollections) return true;

    const collections = await getCollectionsForItem(itemId);
    if (STATE.currentItemId !== itemId) return false;
    if (!collections) return false;

    STATE.currentCollections = collections;
    STATE.currentCollectionsText = STATE.currentCollections
      .map((c) => `${c.Id || ""}:${c.Name || ""}`)
      .join("|");

    return true;
  }

  function applyCurrentCollectionsToDom() {
    // The state may still belong to the previous page (any detail -> detail
    // navigation): never paint it into the new one; the caller rescans.
    if ((getUrlParams().itemId || null) !== STATE.currentItemId) return false;

    const box = findBestDetailsBox();
    if (!box) return false;

    if (!STATE.currentItem || STATE.currentItem.Type !== "Movie") {
      removeRow(box);
      return false;
    }

    if (!STATE.currentCollections || !STATE.currentCollections.length) {
      removeRow(box);
      return false;
    }

    if (!needsInjection(box)) return true;

    injectCollectionRow(box, STATE.currentCollections, STATE.currentServerId);
    markCollectionRow(box);
    return true;
  }

  async function scanAndReconcile() {
    try {
      const token = ++STATE.runToken;

      const ready = await prepareStateForCurrentRoute();
      if (token !== STATE.runToken) return;
      if (!ready) return;

      applyCurrentCollectionsToDom();
    } catch (e) {
      log("Scan failed:", e);
    }
  }

  function scheduleScan(delay = 100) {
    clearTimeout(scheduleScan._t);
    scheduleScan._t = setTimeout(scanAndReconcile, delay);
  }

  function bootScanBurst() {
    scheduleScan(50);
    setTimeout(scanAndReconcile, 250);
    setTimeout(scanAndReconcile, 700);
    setTimeout(scanAndReconcile, 1500);
    setTimeout(scanAndReconcile, 3000);
  }

  let lastRouteKey = "";

  function getRouteKey() {
    const { itemId, serverId } = getUrlParams();
    return `${itemId || ""}:${serverId || ""}`;
  }

  // 12.1 empties .itemDetailsGroup on every render of the page and React fills
  // it again a moment later (apps/legacy/controllers/itemDetails/index.js
  // 1001-1022); the throttled scan below then brought the row back up to
  // 750 ms later (flicker, S-A9). When a mutation removes our row, it is
  // re-applied inside the observer itself (before the next paint) for
  // ROW_LOST_WINDOW_MS after the loss, at most ROW_LOST_MAX_APPLIES times (our
  // own moves also remove nodes; the cap keeps that from looping before a
  // paint). The throttled scan and the interval stay as the fallback.
  // 10.10.7 does not re-render the box (static rows); there this path only
  // re-checks what is already in place (same result, found earlier).
  const ROW_LOST_WINDOW_MS = 2000;
  const ROW_LOST_MAX_APPLIES = 10;
  let rowLostAt = 0;
  let rowLostApplies = 0;
  function removedOwnRow(records) {
    for (const rec of records) {
      for (const n of rec.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches("[data-collection-row]") || n.querySelector("[data-collection-row]")) return true;
      }
    }
    return false;
  }

  new MutationObserver((records) => {
    const routeKey = getRouteKey();

    if (routeKey !== lastRouteKey) {
      lastRouteKey = routeKey;
      bootScanBurst();
      return;
    }

    const lostNow = Date.now();
    if (removedOwnRow(records) && lostNow - rowLostAt >= ROW_LOST_WINDOW_MS) {
      rowLostAt = lostNow;
      rowLostApplies = 0;
    }
    if (lostNow - rowLostAt < ROW_LOST_WINDOW_MS && rowLostApplies < ROW_LOST_MAX_APPLIES) {
      rowLostApplies++;
      try {
        applyCurrentCollectionsToDom();
      } catch (e) {
        log("Re-apply failed:", e);
      }
    }

    const now = Date.now();
    if (now - STATE.lastScanAt > 250) {
      STATE.lastScanAt = now;
      scheduleScan(150);
    }
  }).observe(document.body, {
    childList: true,
    subtree: true
  });

  setInterval(() => {
    const routeKey = getRouteKey();

    if (routeKey !== lastRouteKey) {
      lastRouteKey = routeKey;
      bootScanBurst();
      return;
    }

    if (!applyCurrentCollectionsToDom()) {
      scanAndReconcile();
    }
  }, 750);

  window.addEventListener("hashchange", bootScanBurst);
  window.addEventListener("popstate", bootScanBurst);

  lastRouteKey = getRouteKey();
  bootScanBurst();
})();
