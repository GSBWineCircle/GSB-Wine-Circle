'use strict';

const { parseDollarValue } = require('../services/signupLogic');
const { buildAnalyticsMatrix } = require('../services/analytics');

describe('dollar value handling (analytics null.toFixed crash)', () => {
  test('parseDollarValue: blank is null; numbers kept; junk/negative/NaN/Infinity rejected', () => {
    expect(parseDollarValue('')).toEqual({ ok: true, value: null });
    expect(parseDollarValue(null)).toEqual({ ok: true, value: null });
    expect(parseDollarValue(undefined)).toEqual({ ok: true, value: null });
    expect(parseDollarValue('50')).toEqual({ ok: true, value: 50 });
    expect(parseDollarValue(0)).toEqual({ ok: true, value: 0 });
    expect(parseDollarValue('12.345')).toEqual({ ok: true, value: 12.35 });
    for (const bad of ['abc', 'NaN', NaN, Infinity, '-5', -1, {}, '1e99']) {
      expect(parseDollarValue(bad).ok).toBe(false);
    }
  });

  test('a malformed stored value never makes analytics totals null/NaN', () => {
    const members = [{ member_id: 'm1' }];
    const events = [
      { event_id: 'e1', dollar_value: 'NaN' },
      { event_id: 'e2', dollar_value: '40.00' },
      { event_id: 'e3', dollar_value: null },
    ];
    const rows = ['e1', 'e2', 'e3'].map(id => ({ member_id: 'm1', event_id: id, status: 'Attended' }));
    const { totals, grandTotalDollarValue } = buildAnalyticsMatrix(members, events, rows);
    expect(totals.e1).toMatchObject({ dollarValue: null, totalDollarValue: 0 });
    expect(totals.e2).toMatchObject({ dollarValue: 40, totalDollarValue: 40 });
    expect(grandTotalDollarValue).toBe(40);
    // NaN would have turned into null here, which is what crashed toFixed in the browser
    expect(JSON.parse(JSON.stringify(totals)).e1.totalDollarValue).toBe(0);
  });
});
