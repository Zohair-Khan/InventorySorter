// Pure logic (no DOM, no network) so it can be tested on its own.

export const FALLBACK_SECTIONS = [
  { key: 'fb:monsters', name: 'Main Deck Monsters' },
  { key: 'fb:spells', name: 'Spells' },
  { key: 'fb:traps', name: 'Traps' },
  { key: 'fb:fusion', name: 'Fusion Monsters' },
  { key: 'fb:synchro', name: 'Synchro Monsters', byLevel: true },
  { key: 'fb:xyz', name: 'Xyz Monsters', byLevel: true },
  { key: 'fb:link', name: 'Link Monsters', byLevel: true },
];
export const FALLBACK_BY_KEY = new Map(FALLBACK_SECTIONS.map((s) => [s.key, s]));

// Which type section a card falls into when it has no category.
export function fallbackKey(card) {
  const t = card?.t || '';
  if (t.includes('Fusion')) return 'fb:fusion';
  if (t.includes('Synchro')) return 'fb:synchro';
  if (t.includes('XYZ')) return 'fb:xyz';
  if (t.includes('Link')) return 'fb:link';
  if (t === 'Spell Card') return 'fb:spells';
  if (t === 'Trap Card') return 'fb:traps';
  return 'fb:monsters';
}

export const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
export const byName = (a, b) => collator.compare(a, b);

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const levelOf = (c) => c?.k ?? c?.l ?? 0;

// Shrink a YGOPRODeck card object to what the app needs.
export function slimCard(c) {
  if (!c || c.type === 'Skill Card' || c.type === 'Token') return null;
  const formats = c.misc_info?.[0]?.formats;
  if (Array.isArray(formats) && formats.includes('Rush Duel')) return null;
  return {
    id: c.id,
    n: c.name,
    t: c.type,
    f: c.frameType,
    l: c.level ?? null,
    k: c.linkval ?? null,
    r: c.race ?? '',
    a: (c.card_images || []).map((i) => i.id).filter((id) => id !== c.id),
  };
}

export function buildCardIndex(cards) {
  const byId = new Map();
  const altToBase = new Map();
  const list = [];
  for (const c of cards) {
    c.norm = normalize(c.n);
    c.compact = c.norm.replace(/ /g, '');
    byId.set(c.id, c);
    list.push(c);
  }
  for (const c of cards) {
    for (const a of c.a || []) if (!byId.has(a)) altToBase.set(a, c.id);
  }
  list.sort((a, b) => byName(a.n, b.n));
  return { byId, altToBase, list };
}

// Any passcode (primary or alt art) → primary passcode, or null if unknown.
export function resolveId(index, n) {
  if (index.byId.has(n)) return n;
  return index.altToBase.get(n) ?? null;
}

// .ydk → list of passcodes (with repeats, in file order). Lines before any
// header count as main deck, so a plain list of passcodes also works.
export function parseYdk(text, include = { main: true, extra: true, side: true }) {
  let section = 'main';
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('#main')) { section = 'main'; continue; }
    if (lower.startsWith('#extra')) { section = 'extra'; continue; }
    if (lower.startsWith('!side')) { section = 'side'; continue; }
    if (line.startsWith('#') || line.startsWith('!')) continue;
    const m = line.match(/^(\d+)\b/);
    if (m && include[section]) out.push(parseInt(m[1], 10));
  }
  return out;
}

export function searchCards(index, query, { limit = 40, isOwned = () => false } = {}) {
  const q = String(query || '').trim();
  if (!q || !index) return [];
  if (/^\d{3,}$/.test(q)) {
    const id = resolveId(index, parseInt(q, 10));
    if (id != null) return [index.byId.get(id)];
  }
  const nq = normalize(q);
  if (!nq) return [];
  const tokens = nq.split(' ');
  const cq = nq.replace(/ /g, '');
  const scored = [];
  for (const c of index.list) {
    const n = c.norm;
    let score;
    if (n === nq) score = 0;
    else if (n.startsWith(nq)) score = 1;
    else if (n.includes(nq)) score = 2;
    else if (tokens.every((t) => n.includes(t))) score = 3;
    else if (c.compact.includes(cq)) score = 3;
    else continue;
    if (!isOwned(c.id)) score += 0.5; // owned cards first within each tier
    scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || byName(a[1].n, b[1].n));
  return scored.slice(0, limit).map((x) => x[1]);
}

export const memberCmp = (a, b) =>
  (a.row.package_position ?? 1e9) - (b.row.package_position ?? 1e9) || byName(a.card.n, b.card.n);

// The whole collection in physical filing order.
export function buildSections({ categories, packages, owned, getCard }) {
  const sections = [];
  const map = new Map();
  for (const c of categories) {
    const s = { key: 'cat:' + c.id, name: c.name, kind: 'category', category: c, items: [] };
    sections.push(s);
    map.set(s.key, s);
  }
  for (const f of FALLBACK_SECTIONS) {
    const s = { key: f.key, name: f.name, kind: 'fallback', byLevel: !!f.byLevel, items: [] };
    sections.push(s);
    map.set(s.key, s);
  }

  const members = new Map();
  for (const row of owned.values()) {
    const card = getCard(row.passcode);
    if (row.package_id && packages.has(row.package_id)) {
      if (!members.has(row.package_id)) members.set(row.package_id, []);
      members.get(row.package_id).push({ row, card });
      continue;
    }
    const catKey = row.category_id ? 'cat:' + row.category_id : null;
    const key = catKey && map.has(catKey) ? catKey : fallbackKey(card);
    map.get(key).items.push({ kind: 'card', row, card, name: card.n, level: levelOf(card) });
  }

  for (const [pid, list] of members) {
    list.sort(memberCmp);
    const pkg = packages.get(pid);
    const lead = list[0].card;
    const catKey = pkg.category_id ? 'cat:' + pkg.category_id : null;
    const key = catKey && map.has(catKey) ? catKey : fallbackKey(lead);
    map.get(key).items.push({ kind: 'package', pkg, members: list, name: pkg.name, level: levelOf(lead) });
  }

  for (const s of sections) {
    s.items.sort(
      s.byLevel
        ? (a, b) => a.level - b.level || byName(a.name, b.name)
        : (a, b) => byName(a.name, b.name),
    );
    s.cardCount = s.items.reduce((n, i) => n + (i.kind === 'package' ? i.members.length : 1), 0);
  }
  return sections;
}
