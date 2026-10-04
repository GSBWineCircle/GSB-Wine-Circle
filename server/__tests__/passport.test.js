'use strict';

const tags = require('../services/wineTags');
const stamp = require('../services/passportStamp');
const research = require('../services/wineResearch');

describe('wineTags', () => {
  test('normalizes case, spacing, punctuation and markup', () => {
    expect(tags.normalizeTag('  Dark   CHERRY! ')).toBe('dark cherry');
    expect(tags.normalizeTag('<b>plum</b>')).toBe('plum');
    expect(tags.normalizeTag('<script>alert(1)</script>')).toBe('alert 1');
    expect(tags.normalizeTag('a')).toBeNull();
    expect(tags.normalizeTag('x'.repeat(40))).toBeNull();
    expect(tags.normalizeTag(42)).toBeNull();
  });
  test('list de-duplicates and caps', () => {
    expect(tags.normalizeTagList(['Plum', 'plum!', 'cedar', 7, ''])).toEqual(['plum', 'cedar']);
    expect(tags.normalizeTagList(Array.from({ length: 30 }, (_, i) => 'tag' + i)).length).toBe(tags.MAX_TAGS_PER_NOTE);
    expect(tags.normalizeTagList('nope')).toEqual([]);
  });
  test('infers style', () => {
    expect(tags.inferStyle('Veuve Clicquot Brut Champagne')).toBe('sparkling');
    expect(tags.inferStyle('Whispering Angel Rosé')).toBe('rose');
    expect(tags.inferStyle('Kabinett Riesling')).toBe('white');
    expect(tags.inferStyle('Barolo')).toBe('red');
    expect(tags.inferStyle('Taylor Port')).toBe('fortified');
  });
  test('rule suggestions are grape-aware with a style fallback', () => {
    expect(tags.ruleBasedSuggestions({ grape: 'Pinot Noir' })).toContain('red cherry');
    expect(tags.ruleBasedSuggestions({ name: 'Mystery', style: 'white' })).toContain('citrus');
    expect(tags.ruleBasedSuggestions({}).length).toBeGreaterThan(0);
  });
});

describe('passportStamp', () => {
  test('motif follows keywords; default grapes', () => {
    expect(stamp.pickMotif({ name: 'Champagne Night' })).toBe('bubbles');
    expect(stamp.pickMotif({ name: 'Alpine Reds' })).toBe('mountain');
    expect(stamp.pickMotif({ name: 'Tasting' })).toBe('grapes');
    expect(stamp.pickMotif({ name: 'Burgundy Night' }, [{ region: 'Champagne' }])).toBe('moon');
    expect(stamp.pickMotif({ name: 'Tasting' }, [{ region: 'Champagne' }])).toBe('bubbles');
  });
  test('stamp is deterministic and carries the Pacific event date', () => {
    const ev = { event_id: 'e1', name: 'Spring Whites', event_date: '2026-03-15T03:00:00Z' };
    const a = stamp.buildStamp(ev); const b = stamp.buildStamp(ev);
    expect(a).toEqual(b);
    expect(a.dateLabel).toBe('14 MAR 2026'); // 03:00Z is still the 14th in Pacific time
    expect(stamp.buildStamp({ event_id: 'e2', name: 'x' }).dateLabel).toBe('');
  });
  test('abridges long descriptions on a sentence/word boundary', () => {
    const d = 'A '.repeat(200);
    expect(stamp.abridgeDescription({ description: d }).length).toBeLessThanOrEqual(151);
    expect(stamp.abridgeDescription({ description: '<b>Hi</b> there. See https://x.com now.' })).not.toMatch(/<|http/);
  });
  test('composes a blurb when there is no description', () => {
    expect(stamp.abridgeDescription({ location: 'Lounge' }, [{ country: 'Italy' }])).toBe('A tasting of 1 wine from Italy at Lounge.');
    expect(stamp.abridgeDescription({}, [])).toMatch(/wine/);
  });
});

describe('wineResearch', () => {
  const wine = { name: 'Pommard', grape: 'Pinot Noir', region: 'Burgundy', country: 'France' };
  const gem = text => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

  test('no key -> rule-based', async () => {
    delete process.env.GEMINI_API_KEY;
    const r = await research.suggestTags(wine);
    expect(r.source).toBe('rules');
    expect(r.tags.length).toBeGreaterThan(0);
  });
  test('parses a reply wrapped in prose/fences, sends key header and search tool', async () => {
    const fetch = jest.fn().mockResolvedValue(gem('Here:\n```json\n["Dark Cherry","earthy","silk","violet","forest floor"]\n```'));
    const r = await research.suggestTags(wine, { fetch, apiKey: 'k' });
    expect(r).toEqual({ tags: ['dark cherry', 'earthy', 'silk', 'violet', 'forest floor'], source: 'web' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/generativelanguage\.googleapis\.com.*:generateContent$/);
    expect(init.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(init.body).tools).toEqual([{ google_search: {} }]);
  });
  test('tries the next model when one fails, remembers the one that works', async () => {
    research._resetWorkingModel();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ok = gem('["a1","b2","c3","d4","e5"]');
    const fetch = jest.fn(async url => (/gemini-2\.5-flash:/.test(url) ? { ok: false, status: 404, json: async () => ({}) } : ok));
    const r = await research.suggestTags(wine, { fetch, apiKey: 'k' });
    expect(r.source).toBe('web');
    expect(fetch.mock.calls.map(c => c[0].match(/models\/([^:]+):/)[1])).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
    fetch.mockClear();
    await research.suggestTags(wine, { fetch, apiKey: 'k' });
    expect(fetch.mock.calls[0][0]).toMatch(/gemini-2\.5-flash-lite:/); // remembered
    spy.mockRestore();
    research._resetWorkingModel();
  });
  test('if no model offers grounding, the last attempt runs ungrounded and is labelled model', async () => {
    research._resetWorkingModel();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = jest.fn(async (url, init) => (JSON.parse(init.body).tools ? { ok: false, status: 400, json: async () => ({}) } : gem('["a1","b2","c3","d4","e5"]')));
    const r = await research.suggestTags(wine, { fetch, apiKey: 'k' });
    spy.mockRestore();
    expect(r.source).toBe('model');
    expect(fetch.mock.calls[fetch.mock.calls.length - 1][0]).toMatch(/gemini-flash-latest:/);
    research._resetWorkingModel();
  });
  test('quota error, network error, junk and too-few tags everywhere fall back to rules', async () => {
    for (const fetch of [
      jest.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
      jest.fn().mockRejectedValue(new Error('boom')),
      jest.fn().mockResolvedValue(gem('no json here')),
      jest.fn().mockResolvedValue(gem('["one","two"]')),
      jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [] }) }),
    ]) {
      research._resetWorkingModel();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const r = await research.suggestTags(wine, { fetch, apiKey: 'k' });
      spy.mockRestore();
      expect(r.source).toBe('rules');
    }
  });
  test('commons titles must look like bottle photos and contain the producer tokens', () => {
    const w = { producer: 'Domaine Leroy', name: 'Musigny' };
    expect(research.commonsTitleMatches('File:Leroy Musigny bottle.jpg', w)).toBe(true);
    expect(research.commonsTitleMatches('File:Leroy vineyard.jpg', w)).toBe(false);
    expect(research.commonsTitleMatches('File:Other wine bottle.jpg', w)).toBe(false);
    expect(research.commonsTitleMatches('File:Leroy bottle.svg', w)).toBe(false);
  });
});

describe('passportWines validation', () => {
  const v = require('../services/passportWines');
  test('wine needs a name; style inferred; ids must be ours', () => {
    expect(v.sanitizeWine({ name: '  ' }).ok).toBe(false);
    const r = v.sanitizeWine({ name: 'Brut', grape: 'Chardonnay', region: 'Champagne', wine_id: 'evil' });
    expect(r.ok).toBe(true);
    expect(r.wine.style).toBe('sparkling');
    expect(r.wine.wine_id).toBeNull();
    expect(v.sanitizeWine({ name: 'x', wine_id: 'wine_' + 'a'.repeat(32) }).wine.wine_id).toMatch(/^wine_/);
  });
  test('note rating/tags/empty handling', () => {
    expect(v.sanitizeNoteInput({ rating: 6 }).error).toBeTruthy();
    expect(v.sanitizeNoteInput({ rating: 4.5 }).error).toBeTruthy();
    const n = v.sanitizeNoteInput({ rating: '4', tags: ['Plum', 'plum'], share_tags: 'yes' });
    expect(n).toEqual({ rating: 4, note: '', tags: ['plum'], share_tags: false });
    expect(v.isEmptyNote(v.sanitizeNoteInput({}))).toBe(true);
    expect(v.isEmptyNote(n)).toBe(false);
  });
  test('research key ignores case but not content', () => {
    expect(v.researchKey({ name: 'A' })).toBe(v.researchKey({ name: 'a' }));
    expect(v.researchKey({ name: 'A' })).not.toBe(v.researchKey({ name: 'B' }));
  });
});

describe('passportAccess', () => {
  const { isPassportEnabledFor: ok } = require('../services/passportAccess');
  test('defaults to the maintainer only, case-insensitive', () => {
    expect(ok('rdighe@stanford.edu', '')).toBe(true);
    expect(ok('RDighe@Stanford.edu', undefined)).toBe(true);
    expect(ok('someone@stanford.edu', '')).toBe(false);
    expect(ok('', '')).toBe(false);
  });
  test('env list and wildcard', () => {
    expect(ok('a@x.edu', 'a@x.edu, b@x.edu')).toBe(true);
    expect(ok('rdighe@stanford.edu', 'a@x.edu')).toBe(false);
    expect(ok('anyone@x.edu', '*')).toBe(true);
  });
});

describe('passport art', () => {
  const gem = text => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
  const ev = { name: 'Etna Night', description: 'Volcanic whites', location: 'Lounge' };

  test('every motif has a description and the stamp is always a circle', () => {
    expect(stamp.MOTIF_IDS.length).toBeGreaterThan(25);
    const st = stamp.buildStamp({ event_id: 'e9', name: 'Anything' }, [], { motif: 'volcano' });
    expect(st.shape).toBe('round');
    expect(st.motif).toBe('volcano');
    expect(stamp.buildStamp({ event_id: 'e9', name: 'x' }, [], { motif: 'not-a-motif' }).motif).toBe('grapes');
  });
  test('fallback picks terroir/theme motifs', () => {
    expect(stamp.pickMotif({ name: 'Sicilian Whites' }, [{ region: 'Etna' }])).toBe('volcano');
    expect(stamp.pickMotif({ name: 'Mosel Riesling' })).toBe('river');
    expect(stamp.pickMotif({ name: 'Maya turns 30' })).toBe('cake');
    expect(stamp.pickMotif({ name: 'Blind Tasting' })).toBe('question');
    expect(stamp.pickMotif({ name: 'Grand Cru Night' })).toBe('crown');
  });
  test('short descriptions get a wine line appended', () => {
    expect(stamp.abridgeDescription({ description: 'Rosé on the lawn.' }, [{ region: 'Provence' }, { region: 'Tavel' }]))
      .toBe('Rosé on the lawn. 2 wines from Provence and Tavel.');
  });
  test('parseArt validates motif and blurb', () => {
    const ok = '{"blurb":"Volcanic whites from Etna, poured on a warm night under the lights.","motif":"volcano"}';
    expect(research.parseArt('```json\n' + ok + '\n```')).toEqual({ blurb: 'Volcanic whites from Etna, poured on a warm night under the lights.', motif: 'volcano' });
    expect(research.parseArt('{"blurb":"Volcanic whites from Etna, poured on a warm night.","motif":"dragon"}')).toBeNull();
    expect(research.parseArt('{"blurb":"short","motif":"volcano"}')).toBeNull();
    expect(research.parseArt('nope')).toBeNull();
  });
  test('generateArt: no key -> null; success; failure -> null', async () => {
    delete process.env.GEMINI_API_KEY;
    expect(await research.generateArt(ev, [])).toBeNull();
    const good = gem('{"blurb":"Volcanic whites from Etna, poured on a warm night under the lights.","motif":"volcano"}');
    const fetch = jest.fn().mockResolvedValue(good);
    const art = await research.generateArt(ev, [{ name: 'Etna Bianco', region: 'Etna', country: 'Italy' }], { fetch, apiKey: 'k' });
    expect(art.motif).toBe('volcano');
    expect(JSON.parse(fetch.mock.calls[0][1].body).tools).toBeUndefined(); // ungrounded
    expect(JSON.parse(fetch.mock.calls[0][1].body).contents[0].parts[0].text).toMatch(/Etna Bianco/);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await research.generateArt(ev, [], { fetch: jest.fn().mockRejectedValue(new Error('x')), apiKey: 'k' })).toBeNull();
    spy.mockRestore();
  });
});
