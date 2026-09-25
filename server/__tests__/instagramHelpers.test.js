'use strict';
const {
  MAX_WELCOME_PHOTOS, isValidMediaId, isAllowedImageUrl, isSelectableMedia, validateSelection,
} = require('../services/instagramHelpers');

describe('isValidMediaId', () => {
  test('accepts numeric ids only', () => {
    expect(isValidMediaId('17895695668004550')).toBe(true);
    expect(isValidMediaId('abc')).toBe(false);
    expect(isValidMediaId('12; DROP TABLE')).toBe(false);
    expect(isValidMediaId('')).toBe(false);
    expect(isValidMediaId(123)).toBe(false);
  });
});

describe('isAllowedImageUrl', () => {
  test('allows https Instagram CDN hosts', () => {
    expect(isAllowedImageUrl('https://scontent-sjc3-1.cdninstagram.com/v/t51/x.jpg')).toBe(true);
    expect(isAllowedImageUrl('https://scontent.xx.fbcdn.net/v/x.jpg')).toBe(true);
  });
  test('rejects other hosts, look-alikes, http and junk', () => {
    expect(isAllowedImageUrl('https://evil.example.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://cdninstagram.com.evil.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://notcdninstagram.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('http://scontent.cdninstagram.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedImageUrl('not a url')).toBe(false);
  });
  test('allows an explicitly supplied mock origin only', () => {
    expect(isAllowedImageUrl('http://localhost:9911/a.png', 'http://localhost:9911')).toBe(true);
    expect(isAllowedImageUrl('http://localhost:9912/a.png', 'http://localhost:9911')).toBe(false);
  });
});

describe('isSelectableMedia', () => {
  test('images and carousels with a url are selectable; videos are not', () => {
    expect(isSelectableMedia({ media_type: 'IMAGE', media_url: 'u' })).toBe(true);
    expect(isSelectableMedia({ media_type: 'CAROUSEL_ALBUM', media_url: 'u' })).toBe(true);
    expect(isSelectableMedia({ media_type: 'VIDEO', media_url: 'u' })).toBe(false);
    expect(isSelectableMedia({ media_type: 'IMAGE' })).toBe(false);
    expect(isSelectableMedia(null)).toBe(false);
  });
});

describe('validateSelection', () => {
  test('dedupes and preserves order', () => {
    expect(validateSelection(['3', '1', '3', '2'])).toEqual({ ok: true, ids: ['3', '1', '2'] });
  });
  test('empty selection is valid (clears the welcome photos)', () => {
    expect(validateSelection([])).toEqual({ ok: true, ids: [] });
  });
  test('rejects non-arrays, bad ids and too many photos', () => {
    expect(validateSelection('1').ok).toBe(false);
    expect(validateSelection(['1', 'x']).ok).toBe(false);
    const many = Array.from({ length: MAX_WELCOME_PHOTOS + 1 }, (_, i) => String(i + 1));
    expect(validateSelection(many).ok).toBe(false);
    expect(validateSelection(many.slice(0, MAX_WELCOME_PHOTOS)).ok).toBe(true);
  });
});
