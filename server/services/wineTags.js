/**
 * Pure helpers for tasting-note tags - no DB or network access.
 *
 * Tags are stored normalized (lowercase, single-spaced, letters/numbers and
 * a few punctuation marks only) so "Dark Cherry", "dark  cherry" and
 * "dark cherry!" are the same tag, and so user-entered text can never carry
 * markup into the page.
 */

'use strict';

const MAX_TAG_LENGTH = 24;
const MIN_TAG_LENGTH = 2;
const MAX_TAGS_PER_NOTE = 12;
const MAX_SUGGESTED_TAGS = 10;

/**
 * Normalize one tag, or return null if it isn't usable.
 * @param {*} raw
 * @returns {string|null}
 */
function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw
    .normalize('NFKC')
    .replace(/<[^>]*>/g, ' ')                // markup is dropped, not turned into words
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'&-]/gu, ' ')   // drop anything that isn't a letter, number, space, ' & -
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-'&]+|[-'&]+$/g, '')         // no dangling punctuation
    .trim();
  if (t.length < MIN_TAG_LENGTH || t.length > MAX_TAG_LENGTH) return null;
  return t;
}

/**
 * Normalize a list: drop unusable entries, de-duplicate (keeping order), cap.
 * @param {*} list
 * @param {number} [max]
 * @returns {string[]}
 */
function normalizeTagList(list, max = MAX_TAGS_PER_NOTE) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const t = normalizeTag(raw);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const STYLES = ['red', 'white', 'rose', 'sparkling', 'dessert', 'fortified'];

/**
 * Best guess at a wine's style from free text (name, grape, region).
 * @param {string} text
 * @returns {string} one of STYLES (defaults to 'red')
 */
function inferStyle(text) {
  const s = String(text || '').toLowerCase();
  if (/champagne|prosecco|cava|cr[ée]mant|franciacorta|brut|sparkling|spumante|p[ée]tillant|blanc de blancs|blanc de noirs/.test(s)) return 'sparkling';
  if (/ros[ée]/.test(s)) return 'rose';
  if (/sauternes|tokaji|eiswein|ice wine|icewine|beerenauslese|trockenbeerenauslese|late harvest|vin santo|moscato d'asti|dessert/.test(s)) return 'dessert';
  if (/\bport\b|porto|sherry|madeira|marsala|fino|amontillado|oloroso|vermouth/.test(s)) return 'fortified';
  if (/riesling|chardonnay|sauvignon blanc|albari[ñn]o|pinot grigio|pinot gris|gr[üu]ner|chenin|viognier|vermentino|verdejo|gew[üu]rztraminer|chablis|muscadet|soave|white|blanc|bianco|blanco|weiss/.test(s)) return 'white';
  return 'red';
}

// Descriptor banks used when web research isn't available. Deliberately modest:
// these are "typical for this grape/style" prompts, not claims about one bottle.
const GRAPE_TAGS = [
  [/cabernet sauvignon|bordeaux|pauillac|margaux|m[ée]doc/, ['blackcurrant', 'cedar', 'dark cherry', 'tobacco', 'graphite', 'firm tannins']],
  [/merlot|pomerol|saint-[ée]milion/, ['plum', 'black cherry', 'chocolate', 'velvety', 'violet', 'soft tannins']],
  [/pinot noir|burgundy|bourgogne|gevrey|nuits|volnay|pommard|beaune/, ['red cherry', 'raspberry', 'earthy', 'forest floor', 'violet', 'silky']],
  [/syrah|shiraz|r[hô]ne|cornas|hermitage/, ['blackberry', 'black pepper', 'smoky', 'olive', 'violet', 'meaty']],
  [/grenache|garnacha/, ['strawberry', 'red cherry', 'spice', 'dried herbs', 'warm']],
  [/tempranillo|rioja|ribera/, ['cherry', 'leather', 'vanilla', 'dried fig', 'tobacco', 'spice']],
  [/sangiovese|chianti|brunello/, ['sour cherry', 'dried herbs', 'leather', 'tomato leaf', 'savory']],
  [/nebbiolo|barolo|barbaresco/, ['rose', 'tar', 'cherry', 'licorice', 'leather', 'grippy tannins']],
  [/zinfandel|primitivo/, ['jammy', 'raspberry', 'black pepper', 'bramble', 'spice']],
  [/malbec/, ['plum', 'blackberry', 'violet', 'cocoa', 'juicy']],
  [/amarone|corvina|valpolicella/, ['dried fruit', 'raisin', 'chocolate', 'cherry', 'velvety']],
  [/riesling/, ['green apple', 'lime', 'peach', 'slate', 'petrol', 'high acidity']],
  [/chardonnay|chablis/, ['green apple', 'lemon', 'mineral', 'oak', 'butter', 'creamy']],
  [/sauvignon blanc|sancerre|pouilly/, ['grapefruit', 'gooseberry', 'cut grass', 'citrus', 'flinty']],
  [/albari[ñn]o/, ['peach', 'citrus', 'saline', 'floral', 'mineral']],
  [/chenin|vouvray/, ['quince', 'honey', 'apple', 'lanolin', 'waxy']],
  [/pinot gris|pinot grigio/, ['pear', 'melon', 'almond', 'light', 'crisp']],
];
const STYLE_TAGS = {
  red: ['dark fruit', 'oak', 'spice', 'earthy', 'tannic'],
  white: ['citrus', 'green apple', 'floral', 'mineral', 'crisp'],
  rose: ['strawberry', 'watermelon', 'citrus', 'floral', 'crisp'],
  sparkling: ['brioche', 'green apple', 'citrus', 'toasty', 'fine bubbles', 'chalky'],
  dessert: ['honey', 'apricot', 'orange peel', 'caramel', 'sweet'],
  fortified: ['dried fruit', 'caramel', 'nutty', 'spice', 'raisin'],
};

/**
 * Suggested tags without any web research - from grape/region/name keywords,
 * falling back to the style's generic descriptors.
 * @param {{style?: string, grape?: string, region?: string, name?: string, producer?: string}} wine
 * @returns {string[]}
 */
function ruleBasedSuggestions(wine) {
  const text = [wine.grape, wine.region, wine.name, wine.producer].filter(Boolean).join(' ').toLowerCase();
  const style = STYLES.includes(wine.style) ? wine.style : inferStyle(text);
  let picked = [];
  for (const [re, tags] of GRAPE_TAGS) {
    if (re.test(text)) { picked = tags; break; }
  }
  if (!picked.length) picked = STYLE_TAGS[style] || STYLE_TAGS.red;
  return normalizeTagList(picked, MAX_SUGGESTED_TAGS);
}

module.exports = {
  MAX_TAG_LENGTH, MAX_TAGS_PER_NOTE, MAX_SUGGESTED_TAGS, STYLES,
  normalizeTag, normalizeTagList, inferStyle, ruleBasedSuggestions,
};
