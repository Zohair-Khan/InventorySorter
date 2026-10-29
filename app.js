import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY, IMAGE_BASE } from './config.js';
import {
  FALLBACK_BY_KEY, fallbackKey, byName, slimCard, buildCardIndex, resolveId,
  parseYdk, searchCards, buildSections, memberCmp,
} from './logic.js';

const API = 'https://db.ygoprodeck.com/api/v7/';
const CARD_DB_KEY = 'card-db-v1';
const DAY = 24 * 60 * 60 * 1000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const state = {
  user: null,
  index: null,
  dbVersion: '',
  categories: [],
  packages: new Map(),
  owned: new Map(),
  view: 'collection',
  layout: lsGet('layout') === 'list' ? 'list' : 'grid',
  importPlan: null,
};
let sb = null;

/* ---------------- small UI helpers ---------------- */

function setLoading(msg) {
  const el = $('#loading');
  if (msg) { $('#loading-msg').textContent = msg; el.hidden = false; } else el.hidden = true;
}

let toastTimer;
function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 4000);
}

function errMsg(e) {
  const m = e?.message || String(e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return 'Could not reach the server. If your Supabase project was paused for inactivity, restore it from the Supabase dashboard and try again.';
  }
  return m;
}

async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast(errMsg(e), 'error'); return undefined; }
}

/* ---------------- IndexedDB cache for card data ---------------- */

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('staple-sorter', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  } catch { return undefined; }
}
async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('Could not cache card data', e); }
}

/* ---------------- card database (YGOPRODeck, cached) ---------------- */

async function getDbVersion() {
  const r = await fetch(API + 'checkDBVer.php');
  if (!r.ok) throw new Error(`Version check failed (${r.status})`);
  const j = await r.json();
  return String(j?.[0]?.database_version ?? '');
}

async function downloadCards() {
  setLoading('Downloading the card database (only happens when new cards are released)…');
  const r = await fetch(API + 'cardinfo.php?misc=yes');
  if (!r.ok) throw new Error(`Card download failed (${r.status})`);
  const j = await r.json();
  return j.data.map(slimCard).filter(Boolean);
}

async function loadCardDb(force = false) {
  let cached = await idbGet(CARD_DB_KEY);
  const stale = !cached || force || Date.now() - (cached.checkedAt || 0) > DAY;
  if (stale) {
    try {
      const version = await getDbVersion();
      if (!cached || force || version !== cached.version) {
        cached = { version, cards: await downloadCards(), checkedAt: Date.now() };
      } else {
        cached.checkedAt = Date.now();
      }
      await idbSet(CARD_DB_KEY, cached);
    } catch (e) {
      if (!cached) throw new Error('Could not download the card database from YGOPRODeck. ' + e.message);
      console.warn(e);
      toast('Could not check for new cards; using the saved copy.');
    }
  }
  state.index = buildCardIndex(cached.cards);
  state.dbVersion = cached.version;
}

function getCard(id) {
  return state.index?.byId.get(id)
    || { id, n: `Unknown card #${id}`, t: '', f: 'unknown', l: null, k: null, r: '', a: [], norm: '' };
}

function typeLine(c) {
  if (!c.t) return 'Not in the card database';
  if (!c.t.includes('Monster')) return `${c.r ? c.r + ' ' : ''}${c.t}`;
  let s = `${c.r ? c.r + ' · ' : ''}${c.t}`;
  if (c.k) s += ` · Link-${c.k}`;
  else if (c.l != null) s += ` · ${c.t.includes('XYZ') ? 'Rank' : 'Level'} ${c.l}`;
  return s;
}

/* ---------------- user data (Supabase) ---------------- */

async function fetchAll(table, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').order(order).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function sortCats() {
  state.categories.sort((a, b) => a.position - b.position || byName(a.name, b.name));
}

async function loadUserData() {
  const [cats, pkgs, cards] = await Promise.all([
    fetchAll('categories', 'position'),
    fetchAll('packages', 'created_at'),
    fetchAll('cards', 'passcode'),
  ]);
  state.categories = cats;
  sortCats();
  state.packages = new Map(pkgs.map((p) => [p.id, p]));
  state.owned = new Map(cards.map((c) => [c.passcode, c]));
}

async function upsertCards(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({
      user_id: state.user.id,
      passcode: r.passcode,
      category_id: r.category_id ?? null,
      package_id: r.package_id ?? null,
      package_position: r.package_position ?? null,
    }));
    const { data, error } = await sb.from('cards').upsert(chunk, { onConflict: 'user_id,passcode' }).select();
    if (error) throw error;
    for (const d of data) state.owned.set(d.passcode, d);
  }
}

async function deleteCard(pc) {
  const { error } = await sb.from('cards').delete().eq('user_id', state.user.id).eq('passcode', pc);
  if (error) throw error;
  state.owned.delete(pc);
}

async function createPackage(name, categoryId) {
  const { data, error } = await sb.from('packages')
    .insert({ user_id: state.user.id, name: name.trim(), category_id: categoryId || null })
    .select().single();
  if (error) throw error;
  state.packages.set(data.id, data);
  return data;
}

async function updatePackage(id, patch) {
  const { data, error } = await sb.from('packages').update(patch).eq('id', id).select().single();
  if (error) throw error;
  state.packages.set(id, data);
}

async function deletePackage(id) {
  const pkg = state.packages.get(id);
  const members = packageMembers(id);
  if (members.length) {
    await upsertCards(members.map((m) => ({
      passcode: m.row.passcode, category_id: pkg.category_id, package_id: null, package_position: null,
    })));
  }
  const { error } = await sb.from('packages').delete().eq('id', id);
  if (error) throw error;
  state.packages.delete(id);
}

async function createCategory(name) {
  const position = state.categories.reduce((m, c) => Math.max(m, c.position), -1) + 1;
  const { data, error } = await sb.from('categories')
    .insert({ user_id: state.user.id, name: name.trim(), position }).select().single();
  if (error) throw error;
  state.categories.push(data);
  sortCats();
}

async function renameCategory(id, name) {
  const { data, error } = await sb.from('categories').update({ name: name.trim() }).eq('id', id).select().single();
  if (error) throw error;
  const i = state.categories.findIndex((c) => c.id === id);
  state.categories[i] = data;
}

async function moveCategory(id, dir) {
  const arr = [...state.categories];
  const i = arr.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  const rows = arr.map((c, k) => ({ id: c.id, user_id: c.user_id, name: c.name, position: k }));
  const { data, error } = await sb.from('categories').upsert(rows).select();
  if (error) throw error;
  state.categories = data;
  sortCats();
}

async function deleteCategory(id) {
  const { error } = await sb.from('categories').delete().eq('id', id);
  if (error) throw error;
  state.categories = state.categories.filter((c) => c.id !== id);
  // The database already set these to null (on delete set null); mirror it locally.
  for (const r of state.owned.values()) if (r.category_id === id) r.category_id = null;
  for (const p of state.packages.values()) if (p.category_id === id) p.category_id = null;
}

/* ---------------- locations ---------------- */

const catById = (id) => state.categories.find((c) => c.id === id);
const fallbackName = (card) => FALLBACK_BY_KEY.get(fallbackKey(card)).name;

function packageMembers(pid) {
  const out = [];
  for (const row of state.owned.values()) if (row.package_id === pid) out.push({ row, card: getCard(row.passcode) });
  return out.sort(memberCmp);
}

function nextPos(pid) {
  let max = -1;
  for (const r of state.owned.values()) {
    if (r.package_id === pid && r.package_position != null) max = Math.max(max, r.package_position);
  }
  return max + 1;
}

function packageHome(pkg, members = packageMembers(pkg.id)) {
  const cat = pkg.category_id && catById(pkg.category_id);
  if (cat) return cat.name;
  const lead = members[0]?.card;
  return lead ? `${fallbackName(lead)} (type section)` : 'Type sections';
}

function locationLabel(pc) {
  const row = state.owned.get(pc);
  if (!row) return 'Not in your collection';
  if (row.package_id) {
    const pkg = state.packages.get(row.package_id);
    if (pkg) {
      const m = packageMembers(pkg.id);
      const i = m.findIndex((x) => x.row.passcode === pc);
      return `${packageHome(pkg, m)} → ${pkg.name} package (${i + 1} of ${m.length})`;
    }
  }
  const cat = row.category_id && catById(row.category_id);
  if (cat) return cat.name;
  return `${fallbackName(getCard(pc))} (no category)`;
}

async function setCardLocation(pc, categoryId, packageChoice, newPkgName) {
  categoryId = categoryId || null;
  let packageId = null;
  if (packageChoice === '__new') {
    const name = (newPkgName || '').trim() || getCard(pc).n;
    packageId = (await createPackage(name, categoryId)).id;
  } else if (packageChoice) {
    packageId = packageChoice;
  }
  const prev = state.owned.get(pc);
  const row = packageId
    ? {
      passcode: pc, category_id: null, package_id: packageId,
      package_position: prev?.package_id === packageId ? prev.package_position : nextPos(packageId),
    }
    : { passcode: pc, category_id: categoryId, package_id: null, package_position: null };
  await upsertCards([row]);
}

function categoryOptions(selected, card, forPackage = false) {
  const none = forPackage
    ? "None (files under the lead card's type section)"
    : `None (goes in ${card ? fallbackName(card) : 'its type section'})`;
  return `<option value="">${esc(none)}</option>`
    + state.categories.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function packageOptions(categoryId, selected) {
  const pkgs = [...state.packages.values()]
    .filter((p) => (p.category_id || '') === (categoryId || ''))
    .sort((a, b) => byName(a.name, b.name));
  return '<option value="">No package</option>'
    + pkgs.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
    + `<option value="__new" ${selected === '__new' ? 'selected' : ''}>+ New package…</option>`;
}

/* ---------------- rendering ---------------- */

function thumb(card) {
  return `<span class="thumb frame-${esc(card.f || 'unknown')}"><span class="ph">${esc(card.n)}</span>`
    + `<img loading="lazy" decoding="async" src="${IMAGE_BASE}${card.id}.jpg" alt=""></span>`;
}

function tile(card, n, lead = false) {
  return `<button type="button" class="tile" id="tile-${card.id}" data-card="${card.id}" title="${esc(card.n)}">`
    + `<span class="slot">${n}</span>${thumb(card)}`
    + `<span class="tile-name">${lead ? '<span class="lead-mark" title="Lead card">★</span>' : ''}${esc(card.n)}</span></button>`;
}

function render() {
  $('#stats').textContent = `${state.owned.size.toLocaleString()} cards · ${state.categories.length} categories · ${state.packages.size} packages`;
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $$('[data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${state.view}`; });
  if (state.view === 'collection') renderCollection();
  if (state.view === 'categories') renderCategories();
  refreshImportTargets();
}

function renderCollection() {
  const sections = buildSections({
    categories: state.categories, packages: state.packages, owned: state.owned, getCard,
  });
  const visible = sections.filter((s) => s.kind === 'category' || s.items.length);
  const secId = (s) => 'sec-' + s.key.replace(':', '-');

  $('#jump').innerHTML = '<option value="">Jump to section…</option>'
    + visible.map((s) => `<option value="${secId(s)}">${esc(s.name)} (${s.cardCount})</option>`).join('');

  const root = $('#collection');
  root.className = `layout-${state.layout}`;
  if (!state.owned.size && !state.categories.length) {
    root.innerHTML = `<div class="panel empty-state"><h2>Nothing filed yet</h2>
      <p>Start by creating categories (Handtraps, Board Breakers…) under <button type="button" class="link" data-view="categories">Categories</button>,
      then search for cards above or <button type="button" class="link" data-view="import">import a .ydk</button>.</p></div>`;
    return;
  }

  root.innerHTML = visible.map((s) => {
    let n = 0;
    const body = s.items.length
      ? s.items.map((it) => {
        if (it.kind === 'card') return tile(it.card, ++n);
        return `<div class="pkg"><button type="button" class="pkg-head" data-pkg="${it.pkg.id}">`
          + `<span class="pkg-name">${esc(it.pkg.name)}</span><span class="muted">${it.members.length}</span></button>`
          + `<div class="pkg-cards">${it.members.map((m, i) => tile(m.card, ++n, i === 0)).join('')}</div></div>`;
      }).join('')
      : '<p class="empty">No cards yet.</p>';
    const notes = [
      `${s.cardCount} card${s.cardCount === 1 ? '' : 's'}`,
      s.kind === 'fallback' ? 'by card type' : '',
      s.byLevel ? 'ordered by level/rank' : '',
    ].filter(Boolean).join(' · ');
    return `<section class="sec" id="${secId(s)}"><header class="sec-head"><h2>${esc(s.name)}</h2>`
      + `<span class="muted">${notes}</span></header><div class="items">${body}</div></section>`;
  }).join('');
}

function renderCategories() {
  const counts = new Map();
  const pkgCount = new Map();
  for (const r of state.owned.values()) {
    let cat = r.category_id;
    if (r.package_id) {
      cat = state.packages.get(r.package_id)?.category_id || null;
      pkgCount.set(r.package_id, (pkgCount.get(r.package_id) || 0) + 1);
    }
    if (cat) counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const chips = (cat) => {
    const pkgs = [...state.packages.values()]
      .filter((p) => (p.category_id || '') === cat)
      .sort((a, b) => byName(a.name, b.name));
    return `<div class="chips">${pkgs.map((p) => `<button type="button" class="chip" data-pkg="${p.id}">${esc(p.name)} <span class="muted">${pkgCount.get(p.id) || 0}</span></button>`).join('')}`
      + `<button type="button" class="chip add" data-new-pkg="${cat}">+ Package</button></div>`;
  };

  const list = state.categories.length
    ? `<ol class="cat-list">${state.categories.map((c, i) => `
      <li class="cat-item">
        <div class="cat-row">
          <span class="pos">${i + 1}</span>
          <input class="cat-name" data-cat-id="${c.id}" value="${esc(c.name)}" aria-label="Category name" maxlength="60">
          <span class="muted count">${counts.get(c.id) || 0} cards</span>
          <span class="cat-actions">
            <button type="button" class="icon" data-cat-move="-1" data-id="${c.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="icon" data-cat-move="1" data-id="${c.id}" ${i === state.categories.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button type="button" class="icon danger" data-cat-del="${c.id}" aria-label="Delete category">✕</button>
          </span>
        </div>
        ${chips(c.id)}
      </li>`).join('')}</ol>`
    : '<p class="empty">No categories yet.</p>';

  $('#view-categories').innerHTML = `
    <div class="panel stack">
      <h2>Categories</h2>
      <p class="muted">This order is your filing priority and the order of your boxes. Cards without a category go into the type sections, which come after these.</p>
      <form id="add-cat" class="row">
        <input name="name" placeholder="New category, e.g. Handtraps" required maxlength="60">
        <button class="btn primary" type="submit">Add category</button>
      </form>
      ${list}
    </div>
    <div class="panel stack">
      <h2>Type sections</h2>
      <p class="muted">Main Deck Monsters · Spells · Traps · Fusion · Synchro (by level) · Xyz (by rank) · Link (by rating). Packages here (like Exodia) file under their lead card's section.</p>
      ${chips('')}
    </div>
    <div class="panel stack">
      <h2>Card data</h2>
      <p class="muted">${state.index.list.length.toLocaleString()} cards from YGOPRODeck, database version ${esc(state.dbVersion || 'unknown')}. New releases are picked up automatically (checked at most once a day).</p>
      <div><button type="button" class="btn" id="refresh-db">Re-download card data</button></div>
    </div>`;
}

/* ---------------- search ---------------- */

function closeResults() { $('#search-results').hidden = true; }

function showResults() {
  const q = $('#search').value;
  const box = $('#search-results');
  if (!q.trim()) { box.hidden = true; return; }
  const res = searchCards(state.index, q, { limit: 30, isOwned: (id) => state.owned.has(id) });
  box.innerHTML = res.length
    ? res.map((c) => `<button type="button" class="result" data-card="${c.id}">${thumb(c)}
        <span class="result-text"><span class="result-name">${esc(c.n)}</span>
        <span class="result-loc ${state.owned.has(c.id) ? 'owned' : ''}">${esc(locationLabel(c.id))}</span></span></button>`).join('')
    : '<p class="empty">No cards match.</p>';
  box.hidden = false;
}

function showInCollection(pc) {
  closeModal();
  closeResults();
  state.view = 'collection';
  render();
  const el = document.getElementById(`tile-${pc}`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

/* ---------------- modals ---------------- */

function openModal(html, bind) {
  const dlg = $('#modal');
  const body = document.createElement('div');
  body.innerHTML = html;
  $('#modal-content').replaceChildren(body);
  if (!dlg.open) dlg.showModal();
  bind?.(body);
}
function closeModal() { const d = $('#modal'); if (d.open) d.close(); }

function openCard(pc) {
  const card = getCard(pc);
  const row = state.owned.get(pc);
  const pkg = row?.package_id ? state.packages.get(row.package_id) : null;
  const curCat = pkg ? (pkg.category_id || '') : (row?.category_id || '');
  const alts = card.a?.length ? `<p class="muted small">Alt-art passcodes: ${card.a.join(', ')}</p>` : '';

  openModal(`
    <div class="card-modal">
      <div class="cm-art">${thumb(card)}</div>
      <div class="cm-body stack">
        <div>
          <h2>${esc(card.n)}</h2>
          <p class="muted">${esc(typeLine(card))}</p>
          <p class="muted small">Passcode ${card.id}</p>${alts}
        </div>
        <div class="loc-box ${row ? 'owned' : 'unowned'}">
          <span class="loc-label">${row ? 'Filed in' : 'Status'}</span>
          <strong>${esc(locationLabel(pc))}</strong>
        </div>
        ${row ? `<div class="row wrap">
          <button type="button" class="btn" data-show="${pc}">Show in collection</button>
          ${pkg ? `<button type="button" class="btn" data-pkg="${pkg.id}">Open package</button>` : ''}
        </div>` : ''}
        <form id="loc-form" class="stack">
          <h3>${row ? 'Move' : 'Add to collection'}</h3>
          <label>Category<select name="category">${categoryOptions(curCat, card)}</select></label>
          <label>Package<select name="package">${packageOptions(curCat, pkg?.id || '')}</select></label>
          <label class="new-pkg" hidden>New package name<input name="newPkg" value="${esc(card.n)}"></label>
          <div class="row wrap">
            <button type="submit" class="btn primary">${row ? 'Save' : 'Add'}</button>
            ${row ? `<button type="button" class="btn danger" data-remove="${pc}">Remove from collection</button>` : ''}
          </div>
        </form>
      </div>
    </div>`, (root) => {
    const form = $('#loc-form', root);
    const newWrap = $('.new-pkg', form);
    form.category.addEventListener('change', () => {
      form.package.innerHTML = packageOptions(form.category.value, '');
      newWrap.hidden = true;
    });
    form.package.addEventListener('change', () => { newWrap.hidden = form.package.value !== '__new'; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await guard(async () => {
        await setCardLocation(pc, form.category.value, form.package.value, form.newPkg.value);
        toast(`${card.n} → ${locationLabel(pc)}`, 'ok');
        render();
        openCard(pc);
      });
    });
  });
}

async function memberOp(pid, pc, op) {
  const pkg = state.packages.get(pid);
  const ids = packageMembers(pid).map((m) => m.row.passcode);
  const i = ids.indexOf(pc);
  if (i < 0) return;
  if (op === 'out') {
    await upsertCards([{ passcode: pc, category_id: pkg.category_id, package_id: null, package_position: null }]);
    return;
  }
  if (op === 'up' && i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
  else if (op === 'down' && i < ids.length - 1) [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
  else if (op === 'lead') { ids.splice(i, 1); ids.unshift(pc); } else return;
  await upsertCards(ids.map((id, k) => ({ ...state.owned.get(id), package_position: k })));
}

function openPackage(pid) {
  const pkg = state.packages.get(pid);
  if (!pkg) { closeModal(); return; }
  const members = packageMembers(pid);
  const leadName = members[0]?.card.n;

  const memberList = members.length
    ? `<ol class="member-list">${members.map((m, i) => `
        <li>
          ${thumb(m.card)}
          <button type="button" class="link member-name" data-card="${m.card.id}">${i === 0 ? '<span class="lead-mark">★</span> ' : ''}${esc(m.card.n)}</button>
          <span class="member-actions">
            <button type="button" class="icon" data-mv="up" data-pc="${m.card.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="icon" data-mv="down" data-pc="${m.card.id}" ${i === members.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button type="button" class="icon" data-mv="lead" data-pc="${m.card.id}" ${i === 0 ? 'disabled' : ''} title="Make lead card" aria-label="Make lead card">★</button>
            <button type="button" class="icon danger" data-mv="out" data-pc="${m.card.id}" title="Take out of package" aria-label="Take out of package">✕</button>
          </span>
        </li>`).join('')}</ol>`
    : '<p class="empty">No cards yet. Add some below.</p>';

  openModal(`
    <div class="stack">
      <h2>Package</h2>
      <form id="pkg-form" class="stack">
        <label>Name<input name="name" value="${esc(pkg.name)}" required maxlength="80"></label>
        <label>Category<select name="category">${categoryOptions(pkg.category_id || '', null, true)}</select></label>
        <div class="row wrap">
          <button class="btn primary" type="submit">Save</button>
          ${leadName && leadName !== pkg.name ? `<button type="button" class="btn" id="use-lead-name">Use lead card's name</button>` : ''}
        </div>
      </form>
      <h3>Cards <span class="muted small">in filing order; the first is the lead</span></h3>
      ${memberList}
      <label>Add a card<input id="pkg-add-q" placeholder="Search by name or passcode" autocomplete="off"></label>
      <div id="pkg-add-results" class="mini-results"></div>
      <div class="row end"><button type="button" class="btn danger" id="pkg-delete">Delete package</button></div>
    </div>`, (root) => {
    const form = $('#pkg-form', root);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await guard(async () => {
        await updatePackage(pid, { name: form.elements.name.value.trim(), category_id: form.elements.category.value || null });
        toast('Package saved', 'ok');
        render();
        openPackage(pid);
      });
    });
    $('#use-lead-name', root)?.addEventListener('click', () => { form.elements.name.value = leadName; });

    root.addEventListener('click', async (e) => {
      const mv = e.target.closest('[data-mv]');
      if (mv) {
        await guard(async () => { await memberOp(pid, +mv.dataset.pc, mv.dataset.mv); render(); openPackage(pid); });
        return;
      }
      const add = e.target.closest('[data-add-pc]');
      if (add) {
        await guard(async () => {
          await setCardLocation(+add.dataset.addPc, null, pid);
          render();
          openPackage(pid);
          $('#pkg-add-q')?.focus();
        });
      }
    });

    const q = $('#pkg-add-q', root);
    const results = $('#pkg-add-results', root);
    let t;
    q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const res = searchCards(state.index, q.value, { limit: 8, isOwned: (id) => state.owned.has(id) })
          .filter((c) => state.owned.get(c.id)?.package_id !== pid);
        results.innerHTML = res.map((c) => `<div class="mini-result">
            <span><strong>${esc(c.n)}</strong><br><span class="muted small">${esc(locationLabel(c.id))}</span></span>
            <button type="button" class="btn small" data-add-pc="${c.id}">Add</button></div>`).join('');
      }, 100);
    });

    $('#pkg-delete', root).addEventListener('click', async () => {
      const where = pkg.category_id ? catById(pkg.category_id)?.name : 'their type sections';
      if (!confirm(`Delete the "${pkg.name}" package? Its ${members.length} card(s) stay in your collection, loose in ${where}.`)) return;
      await guard(async () => { await deletePackage(pid); closeModal(); render(); toast('Package deleted'); });
    });
  });
}

/* ---------------- import ---------------- */

function refreshImportTargets() {
  const cat = $('#imp-cat');
  const v = cat.value;
  cat.innerHTML = '<option value="">None: just mark as owned (type sections)</option>'
    + state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  cat.value = [...cat.options].some((o) => o.value === v) ? v : '';
  refreshImportPkgs();
}

function refreshImportPkgs() {
  const sel = $('#imp-pkg');
  const v = sel.value;
  sel.innerHTML = packageOptions($('#imp-cat').value, v);
  if (![...sel.options].some((o) => o.value === v)) sel.value = '';
  $('#imp-newpkg-wrap').hidden = sel.value !== '__new';
}

function buildImportPlan() {
  const raw = parseYdk($('#imp-text').value, {
    main: $('#imp-main').checked, extra: $('#imp-extra').checked, side: $('#imp-side').checked,
  });
  const seen = new Set();
  const items = [];
  const unknown = [];
  for (const n of raw) {
    const id = resolveId(state.index, n);
    if (id == null) { if (!unknown.includes(n)) unknown.push(n); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id });
  }
  const catId = $('#imp-cat').value;
  const pkgChoice = $('#imp-pkg').value;
  const newName = $('#imp-newpkg').value.trim();
  for (const it of items) {
    const row = state.owned.get(it.id);
    if (!row) { it.status = 'new'; continue; }
    let here;
    if (pkgChoice === '__new') here = false;
    else if (pkgChoice) here = row.package_id === pkgChoice;
    else here = !row.package_id && (row.category_id || '') === catId;
    if (here) { it.status = 'here'; continue; }
    it.status = 'move';
    it.from = locationLabel(it.id);
    it.defaultMove = !row.package_id && !row.category_id; // undecided cards move by default
  }
  return { lines: raw.length, items, unknown, catId, pkgChoice, newName };
}

function destinationLabel(plan) {
  const cat = plan.catId ? catById(plan.catId)?.name : null;
  if (plan.pkgChoice === '__new') {
    const first = plan.items.find((i) => i.status !== 'here');
    const name = plan.newName || (first ? getCard(first.id).n : 'new package');
    return `new package "${name}" in ${cat || "the lead card's type section"}`;
  }
  if (plan.pkgChoice) return `"${state.packages.get(plan.pkgChoice)?.name}" package in ${cat || 'type sections'}`;
  return cat || 'type sections (no category)';
}

function renderImportPlan(plan) {
  const g = { new: [], move: [], here: [] };
  for (const it of plan.items) g[it.status].push(it);
  const names = (list) => `<div class="chips">${list.map((i) => `<span class="chip static">${esc(getCard(i.id).n)}</span>`).join('')}</div>`;
  const parts = [];
  parts.push(`<div class="loc-box owned"><span class="loc-label">Destination</span><strong>${esc(destinationLabel(plan))}</strong></div>`);
  parts.push(`<p class="muted">${plan.lines} passcode line(s) read → ${plan.items.length} unique card(s).</p>`);
  if (g.new.length) parts.push(`<details open><summary>Will be added (${g.new.length})</summary>${names(g.new)}</details>`);
  if (g.move.length) {
    parts.push(`<details open><summary>Already filed somewhere else (${g.move.length})</summary>
      <p class="muted small">Checked cards will move here. Cards that had no category are checked by default.</p>
      <div class="row"><button type="button" class="btn small" id="imp-all">Check all</button><button type="button" class="btn small" id="imp-none">Check none</button></div>
      <ul class="move-list">${g.move.map((i) => `<li><label class="check"><input type="checkbox" data-move-id="${i.id}" ${i.defaultMove ? 'checked' : ''}>
        <span><strong>${esc(getCard(i.id).n)}</strong> <span class="muted small">currently ${esc(i.from)}</span></span></label></li>`).join('')}</ul></details>`);
  }
  if (g.here.length) parts.push(`<details><summary>Already here, skipped (${g.here.length})</summary>${names(g.here)}</details>`);
  if (plan.unknown.length) {
    parts.push(`<details open><summary>Not recognized (${plan.unknown.length})</summary>
      <p class="muted small">These passcodes aren't in the card database: ${plan.unknown.join(', ')}</p></details>`);
  }
  if (g.new.length || g.move.length) parts.push('<div class="row"><button type="button" class="btn primary" id="imp-apply">Apply import</button></div>');
  else parts.push('<p class="muted">Nothing to import.</p>');
  $('#imp-result').innerHTML = `<div class="stack import-plan">${parts.join('')}</div>`;
}

async function applyImport() {
  const plan = state.importPlan;
  if (!plan) return;
  const checked = new Set($$('[data-move-id]:checked').map((el) => +el.dataset.moveId));
  const toWrite = plan.items.filter((i) => i.status === 'new' || (i.status === 'move' && checked.has(i.id))).map((i) => i.id);
  if (!toWrite.length) { toast('Nothing selected to import'); return; }

  const btn = $('#imp-apply');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  await guard(async () => {
    let packageId = null;
    const categoryId = plan.catId || null;
    if (plan.pkgChoice === '__new') {
      packageId = (await createPackage(plan.newName || getCard(toWrite[0]).n, categoryId)).id;
    } else if (plan.pkgChoice) {
      packageId = plan.pkgChoice;
    }
    let pos = packageId ? nextPos(packageId) : null;
    const rows = toWrite.map((id) => (packageId
      ? { passcode: id, category_id: null, package_id: packageId, package_position: pos++ }
      : { passcode: id, category_id: categoryId, package_id: null, package_position: null }));
    await upsertCards(rows);
    const added = plan.items.filter((i) => i.status === 'new').length;
    const moved = toWrite.length - added;
    state.importPlan = null;
    $('#imp-result').innerHTML = `<div class="loc-box owned"><strong>Done.</strong> Added ${added} card(s)${moved ? `, moved ${moved}` : ''}.</div>`;
    if (plan.pkgChoice === '__new') $('#imp-pkg').value = packageId;
    render();
    toast('Import complete', 'ok');
  });
  if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Apply import'; }
}

/* ---------------- wiring ---------------- */

function wireUp() {
  // Missing images: show a colored placeholder with the card name instead.
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement) t.closest('.thumb')?.classList.add('missing');
  }, true);

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-card],[data-pkg],[data-show],[data-remove],[data-view],[data-layout],[data-new-pkg]');
    if (!t) return;
    const d = t.dataset;
    if (d.view) { closeModal(); state.view = d.view; render(); window.scrollTo(0, 0); return; }
    if (d.layout) { state.layout = d.layout; lsSet('layout', d.layout); render(); return; }
    if (d.show) { showInCollection(+d.show); return; }
    if (d.remove) {
      const card = getCard(+d.remove);
      if (!confirm(`Remove ${card.n} from your collection?`)) return;
      await guard(async () => { await deleteCard(+d.remove); closeModal(); render(); toast(`${card.n} removed`); });
      return;
    }
    if (d.newPkg !== undefined) {
      const name = prompt('Package name (e.g. the lead card, or "Psy-Frame")');
      if (!name?.trim()) return;
      await guard(async () => { const p = await createPackage(name, d.newPkg || null); render(); openPackage(p.id); });
      return;
    }
    if (d.pkg) { closeResults(); openPackage(d.pkg); return; }
    if (d.card) { closeResults(); openCard(+d.card); }
  });

  // Search
  const input = $('#search');
  let st;
  input.addEventListener('input', () => { clearTimeout(st); st = setTimeout(showResults, 100); });
  input.addEventListener('focus', () => { if (input.value.trim()) showResults(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Without this, the same keypress "clicks" the dialog's close button once focus moves into it.
      e.preventDefault();
      const first = $('#search-results [data-card]');
      if (first) { closeResults(); openCard(+first.dataset.card); }
    } else if (e.key === 'Escape') { closeResults(); input.blur(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) closeResults(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input,textarea,select')) { e.preventDefault(); input.focus(); input.select(); }
  });

  // Modal
  const dlg = $('#modal');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('.modal-close').addEventListener('click', () => dlg.close());

  // Collection toolbar
  $('#jump').addEventListener('change', (e) => {
    document.getElementById(e.target.value)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    e.target.value = '';
  });

  // Categories view
  const cv = $('#view-categories');
  cv.addEventListener('submit', async (e) => {
    if (e.target.id !== 'add-cat') return;
    e.preventDefault();
    const name = e.target.elements.name.value;
    await guard(async () => { await createCategory(name); render(); $('#add-cat input')?.focus(); });
  });
  cv.addEventListener('change', async (e) => {
    const inp = e.target.closest('.cat-name');
    if (!inp) return;
    const id = inp.dataset.catId;
    if (!inp.value.trim()) { inp.value = catById(id)?.name || ''; return; }
    await guard(async () => { await renameCategory(id, inp.value); render(); toast('Category renamed', 'ok'); });
  });
  cv.addEventListener('click', async (e) => {
    const mv = e.target.closest('[data-cat-move]');
    if (mv) { await guard(async () => { await moveCategory(mv.dataset.id, +mv.dataset.catMove); render(); }); return; }
    const del = e.target.closest('[data-cat-del]');
    if (del) {
      const cat = catById(del.dataset.catDel);
      if (!confirm(`Delete "${cat.name}"? Its cards stay in your collection and go back to their type sections. Its packages keep their cards and move to the type sections too.`)) return;
      await guard(async () => { await deleteCategory(cat.id); render(); toast('Category deleted'); });
      return;
    }
    if (e.target.closest('#refresh-db')) {
      setLoading('Refreshing card data…');
      await guard(async () => { await loadCardDb(true); render(); toast('Card data refreshed', 'ok'); });
      setLoading(null);
    }
  });

  // Import view
  $('#imp-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    $('#imp-text').value = await f.text();
    e.target.value = '';
    $('#imp-result').innerHTML = '';
  });
  $('#imp-cat').addEventListener('change', () => { refreshImportPkgs(); $('#imp-result').innerHTML = ''; });
  $('#imp-pkg').addEventListener('change', () => { $('#imp-newpkg-wrap').hidden = $('#imp-pkg').value !== '__new'; $('#imp-result').innerHTML = ''; });
  $('#imp-preview').addEventListener('click', () => {
    state.importPlan = buildImportPlan();
    renderImportPlan(state.importPlan);
  });
  $('#imp-clear').addEventListener('click', () => {
    $('#imp-text').value = '';
    $('#imp-result').innerHTML = '';
    state.importPlan = null;
  });
  $('#imp-result').addEventListener('click', (e) => {
    if (e.target.id === 'imp-apply') applyImport();
    if (e.target.id === 'imp-all') $$('[data-move-id]').forEach((c) => { c.checked = true; });
    if (e.target.id === 'imp-none') $$('[data-move-id]').forEach((c) => { c.checked = false; });
  });

  $('#sign-out').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
}

/* ---------------- boot ---------------- */

async function start(user) {
  state.user = user;
  setLoading('Loading your collection…');
  try {
    await Promise.all([loadCardDb(), loadUserData()]);
  } catch (e) {
    console.error(e);
    setLoading(null);
    $('#fatal-msg').textContent = errMsg(e);
    $('#fatal').hidden = false;
    return;
  }
  setLoading(null);
  $('#app').hidden = false;
  wireUp();
  render();
}

function showLogin() {
  setLoading(null);
  $('#login').hidden = false;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $('button', f);
    $('#login-error').textContent = '';
    btn.disabled = true;
    const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    btn.disabled = false;
    if (error) { $('#login-error').textContent = errMsg(error); return; }
    $('#login').hidden = true;
    await start(data.user);
  });
}

async function boot() {
  if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_KEY.startsWith('YOUR-')) {
    setLoading(null);
    $('#setup-needed').hidden = false;
    return;
  }
  sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await start(session.user);
    else showLogin();
  } catch (e) {
    setLoading(null);
    $('#fatal-msg').textContent = errMsg(e);
    $('#fatal').hidden = false;
  }
}

boot();
