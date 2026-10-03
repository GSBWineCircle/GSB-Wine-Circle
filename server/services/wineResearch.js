/**
 * Wine research for the passport: tasting-note suggestions and a bottle image.
 *
 * Suggestions: when GEMINI_API_KEY is set, Gemini (Google AI Studio free tier)
 * researches the wine with Google Search grounding and returns descriptor tags.
 * On ANY failure (no key, quota/API error, unparseable reply) we fall back to rule-based
 * suggestions, so saving a wine list never fails because research did.
 *
 * Image: best-effort lookup on Wikimedia Commons (openly licensed) with strict
 * title matching; if nothing matches, no image is stored and the member page
 * draws a representative bottle for the wine's style. Admins can also upload
 * a photo.
 */

'use strict';

const { normalizeTagList, ruleBasedSuggestions, inferStyle, MAX_SUGGESTED_TAGS } = require('./wineTags');

// Google AI Studio (Gemini API) free tier. Grounding with Google Search is free
// only on some models (currently the 2.5 family) and Google retires/renames
// models over time, so instead of pinning one name we try a ranked list and
// remember the first that works. Set GEMINI_MODEL to put a model at the front.
// The last entry is the "-latest" alias used WITHOUT search, so research keeps
// producing (model-knowledge) suggestions even if no model offers free grounding.
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
].filter(Boolean);
const GEMINI_URL = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
let workingModel = null; // last model that answered; tried first next time

function describeWine(w) {
  return [w.producer, w.name, w.vintage, w.grape && `(${w.grape})`, [w.region, w.country].filter(Boolean).join(', ')]
    .filter(Boolean).join(' ');
}

/** Pull the JSON array of tags out of a model reply. Tolerates prose/fences around it. */
function parseTagsFromText(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return normalizeTagList(JSON.parse(m[0]), MAX_SUGGESTED_TAGS);
  } catch (_) {
    return [];
  }
}

/**
 * @param {object} wine
 * @param {{fetch?: Function, apiKey?: string}} [opts] injectable for tests
 * @returns {Promise<{tags: string[], source: 'web'|'model'|'rules'}>}
 */
async function suggestTags(wine, opts = {}) {
  const fallback = () => ({ tags: ruleBasedSuggestions(wine), source: 'rules' });
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return fallback();
  const fetchImpl = opts.fetch || global.fetch;

  const prompt =
    `Research this wine online and list the tasting descriptors critics and producers use for it: ${describeWine(wine)}.\n` +
    `Reply with ONLY a JSON array of 8 to 10 short lowercase descriptor tags (1-3 words each, e.g. "dark cherry", ` +
    `"cedar", "silky tannins") covering aromas, flavours and texture. No prose.`;

  // One attempt: returns tags (possibly too few) or throws on HTTP/network failure.
  async function ask(model, grounded) {
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    // Search grounding can't be combined with a forced JSON response mode, so
    // the reply is parsed out of plain text instead.
    if (grounded) body.tools = [{ google_search: {} }];
    const resp = await fetchImpl(GEMINI_URL(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`Gemini ${model} HTTP ${resp.status}`);
    const data = await resp.json();
    const cand = (data.candidates || [])[0];
    const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('\n');
    return parseTagsFromText(text);
  }

  // Grounded attempts first (working model first), then one ungrounded attempt.
  const order = [...new Set([workingModel, ...MODEL_CANDIDATES].filter(Boolean))];
  const attempts = order.map((m, i) => ({ model: m, grounded: i < order.length - 1 || order.length === 1 }));
  for (const { model, grounded } of attempts) {
    try {
      const tags = await ask(model, grounded);
      // Too few usable tags means the research didn't really work - prefer the rules.
      if (tags.length < 4) continue;
      workingModel = model;
      return { tags, source: grounded ? 'web' : 'model' };
    } catch (err) {
      console.error('Wine tag research failed:', err.message);
    }
  }
  return fallback();
}

// ── Bottle image (Wikimedia Commons) ─────────────────────────────────────────
const UA = 'GSBWineCircleApp/1.0 (https://gsb.wine; wine tasting club passport)';
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

const STOP = new Set(['the', 'and', 'de', 'di', 'du', 'la', 'le', 'les', 'del', 'des', 'of', 'wine', 'wines', 'estate', 'winery', 'domaine', 'chateau', 'château', 'bodega', 'cuvee', 'cuvée', 'reserve', 'reserva', 'grand', 'vin']);

function tokens(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP.has(t));
}

/**
 * Strict match: a Commons file only counts if its title looks like a bottle
 * photo AND contains every distinctive token of the wine's producer/name.
 * (Wrong-but-plausible pictures are worse than the drawn fallback.)
 */
function commonsTitleMatches(title, wine) {
  const t = String(title || '').toLowerCase();
  if (!/\.(jpe?g|png)$/.test(t)) return false;
  if (!/bottle|botella|bouteille|flasche|label|etikett/.test(t)) return false;
  const need = tokens(wine.producer || wine.name);
  if (!need.length) return false;
  const have = new Set(tokens(t));
  return need.every(tok => have.has(tok));
}

async function fetchJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * @returns {Promise<{buffer: Buffer, contentType: string, source: string}|null>}
 */
async function findBottleImage(wine, opts = {}) {
  const fetchImpl = opts.fetch || global.fetch;
  try {
    const q = encodeURIComponent(`${wine.producer || ''} ${wine.name} bottle`.trim());
    const search = await fetchJson(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${q}&srnamespace=6&srlimit=8&format=json&origin=*`,
      fetchImpl
    );
    const hits = (search.query && search.query.search) || [];
    const hit = hits.find(h => commonsTitleMatches(h.title, wine));
    if (!hit) return null;

    const info = await fetchJson(
      `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(hit.title)}&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=500&format=json&origin=*`,
      fetchImpl
    );
    const page = Object.values((info.query && info.query.pages) || {})[0];
    const ii = page && page.imageinfo && page.imageinfo[0];
    if (!ii || !/^image\/(jpeg|png)$/.test(ii.mime || '')) return null;
    const license = ((ii.extmetadata || {}).LicenseShortName || {}).value || '';
    // Only openly reusable files.
    if (!/^(CC|Public domain|PD)/i.test(license)) return null;

    const img = await fetchImpl(ii.thumburl || ii.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!img.ok) return null;
    const buffer = Buffer.from(await img.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
    return { buffer, contentType: ii.mime, source: `${ii.descriptionurl || hit.title} (${license})` };
  } catch (err) {
    console.error('Bottle image lookup failed:', err.message);
    return null;
  }
}

/** Fill in a wine's missing style, then research tags. */
async function researchWine(wine, opts = {}) {
  const style = wine.style || inferStyle(`${wine.grape} ${wine.name} ${wine.region}`);
  const { tags, source } = await suggestTags({ ...wine, style }, opts);
  return { style, tags, source };
}

module.exports = { _resetWorkingModel: () => { workingModel = null; }, suggestTags, researchWine, findBottleImage, parseTagsFromText, commonsTitleMatches, describeWine };
