/**
 * Wine research for the passport: tasting-note suggestions and a bottle image.
 *
 * Suggestions: when ANTHROPIC_API_KEY is set, Claude researches the wine with
 * the server-side web_search tool and returns descriptor tags. On ANY failure
 * (no key, API error, refusal, unparseable reply) we fall back to rule-based
 * suggestions, so saving a wine list never fails because research did.
 *
 * Image: best-effort lookup on Wikimedia Commons (openly licensed) with strict
 * title matching; if nothing matches, no image is stored and the member page
 * draws a representative bottle for the wine's style. Admins can also upload
 * a photo.
 */

'use strict';

const { normalizeTagList, ruleBasedSuggestions, inferStyle, MAX_SUGGESTED_TAGS } = require('./wineTags');

const MODEL = process.env.PASSPORT_RESEARCH_MODEL || 'claude-opus-5-5';
const MAX_PAUSE_TURNS = 4;

let sdkClient = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!sdkClient) {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic || mod;
    sdkClient = new Anthropic();
  }
  return sdkClient;
}

function describeWine(w) {
  return [w.producer, w.name, w.vintage, w.grape && `(${w.grape})`, [w.region, w.country].filter(Boolean).join(', ')]
    .filter(Boolean).join(' ');
}

/** Pull the JSON array of tags out of a model reply. Tolerates prose/fences around it. */
function parseTagsFromText(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return normalizeTagList(arr, MAX_SUGGESTED_TAGS);
  } catch (_) {
    return [];
  }
}

/**
 * @param {object} wine
 * @param {{client?: object}} [opts] client is injectable for tests
 * @returns {Promise<{tags: string[], source: 'web'|'rules'}>}
 */
async function suggestTags(wine, opts = {}) {
  const fallback = () => ({ tags: ruleBasedSuggestions(wine), source: 'rules' });
  const client = opts.client || getClient();
  if (!client) return fallback();

  try {
    const messages = [{
      role: 'user',
      content:
        `Research this wine online and list the tasting descriptors critics and producers use for it: ${describeWine(wine)}.\n` +
        `Reply with ONLY a JSON array of 8 to 10 short lowercase descriptor tags (1-3 words each, e.g. "dark cherry", ` +
        `"cedar", "silky tannins") covering aromas, flavours and texture. No prose.`,
    }];
    let response;
    for (let turn = 0; turn <= MAX_PAUSE_TURNS; turn++) {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: 'medium' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        messages,
      });
      if (response.stop_reason !== 'pause_turn') break;
      // The server paused a long-running turn: re-send as-is to let it continue.
      messages.push({ role: 'assistant', content: response.content });
    }
    if (response.stop_reason === 'refusal' || response.stop_reason === 'pause_turn') return fallback();

    const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const tags = parseTagsFromText(text);
    // Too few usable tags means the research didn't really work - prefer the rules.
    if (tags.length < 4) return fallback();
    return { tags, source: 'web' };
  } catch (err) {
    console.error('Wine tag research failed, using rules:', err.message);
    return fallback();
  }
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

module.exports = { suggestTags, researchWine, findBottleImage, parseTagsFromText, commonsTitleMatches, describeWine };
