/**
 * Unit tests for Wine Circle core business logic.
 * Covers: lottery split, decline/flake timing, auto-promotion trigger,
 * fee-block enforcement, finalize behaviour, and payment clearing.
 *
 * All tests import from production modules — no local re-implementations.
 */

'use strict';

const {
  computeBalance,
  determineDeclineOutcome,
  assignLotteryResults,
  assignLotteryResultsWithPriority,
  shouldAutoPromote,
  classifyFinalizeSignups,
  isMemberBlocked,
  canManualAddToEvent,
  canRemoveFromInvited,
  isValidBirthDateInput,
  isValidBirthYear,
  extractBirthYear,
  hasBirthYearPriority,
} = require('../services/signupLogic');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns a Date that is `hours` hours from now (positive = future). */
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

const DEFAULT_SETTINGS = {
  decline_grace_window_hours: '24',
  flake_fee_amount: '30',
};

// ─── computeBalance ───────────────────────────────────────────────────────────

describe('computeBalance', () => {
  test('returns 0 for empty ledger', () => {
    expect(computeBalance([])).toBe(0);
  });

  test('single charge', () => {
    expect(computeBalance([{ type: 'Charge', amount: '30' }])).toBe(30);
  });

  test('charge fully paid → 0', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('charge partially paid → remainder', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '10' },
    ];
    expect(computeBalance(ledger)).toBe(20);
  });

  test('charge waived → 0', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Waiver', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('multiple charges accumulated', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Charge', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(60);
  });

  test('overpayment clamps to 0 (never negative)', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '50' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('type comparison is case-insensitive', () => {
    const ledger = [
      { type: 'charge', amount: '30' },
      { type: 'payment', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });
});

// ─── isMemberBlocked ─────────────────────────────────────────────────────────

describe('isMemberBlocked', () => {
  test('active member with zero balance is not blocked', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Active' })).toBe(false);
  });

  test('member with positive fee_balance is blocked', () => {
    expect(isMemberBlocked({ fee_balance: '30', status: 'Active' })).toBe(true);
  });

  test('member with Blocked status is blocked even if balance is 0', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Blocked' })).toBe(true);
  });

  test('member with both positive balance and Blocked status is blocked', () => {
    expect(isMemberBlocked({ fee_balance: '30', status: 'Blocked' })).toBe(true);
  });

  test('inactive member with zero balance is not blocked', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Inactive' })).toBe(false);
  });

  test('treats numeric fee_balance correctly', () => {
    expect(isMemberBlocked({ fee_balance: 0, status: 'Active' })).toBe(false);
    expect(isMemberBlocked({ fee_balance: 1, status: 'Active' })).toBe(true);
  });
});

// ─── assignLotteryResults ─────────────────────────────────────────────────────

describe('assignLotteryResults — Invited/Waitlist split at capacity boundary', () => {
  function makePending(n) {
    return Array.from({ length: n }, (_, i) => ({ signup_id: `s${i + 1}` }));
  }

  test('all invited when signups < capacity', () => {
    const results = assignLotteryResults(makePending(3), 5);
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.newStatus).toBe('Invited'));
  });

  test('all invited when signups == capacity (boundary)', () => {
    const results = assignLotteryResults(makePending(5), 5);
    results.forEach(r => expect(r.newStatus).toBe('Invited'));
  });

  test('first N get Invited, rest get Waitlist when signups > capacity', () => {
    const results = assignLotteryResults(makePending(8), 5);
    const invited    = results.filter(r => r.newStatus === 'Invited');
    const waitlisted = results.filter(r => r.newStatus === 'Waitlist');
    expect(invited).toHaveLength(5);
    expect(waitlisted).toHaveLength(3);
  });

  test('capacity 0 → everyone on waitlist', () => {
    const results = assignLotteryResults(makePending(4), 0);
    results.forEach(r => expect(r.newStatus).toBe('Waitlist'));
  });

  test('empty pending → empty results', () => {
    expect(assignLotteryResults([], 10)).toHaveLength(0);
  });

  test('lottery ranks are sequential starting at 1', () => {
    const results = assignLotteryResults(makePending(5), 5);
    results.forEach((r, i) => expect(r.lottery_rank).toBe(i + 1));
  });

  test('Waitlist ranks continue after Invited ranks', () => {
    const results = assignLotteryResults(makePending(4), 2);
    expect(results[2].lottery_rank).toBe(3);
    expect(results[3].lottery_rank).toBe(4);
  });

  test('signup_id is preserved in output', () => {
    const pending = [{ signup_id: 'abc' }, { signup_id: 'xyz' }];
    const results = assignLotteryResults(pending, 1);
    expect(results[0].signup_id).toBe('abc');
    expect(results[1].signup_id).toBe('xyz');
  });
});

// ─── assignLotteryResultsWithPriority ─────────────────────────────────────────

describe('assignLotteryResultsWithPriority — Admin/Exec always win', () => {
  const p = (id) => ({ signup_id: id, priority: true });
  const n = (id) => ({ signup_id: id, priority: false });
  const statusOf = (results, id) => results.find(r => r.signup_id === id).newStatus;

  test('a priority entrant wins even when placed last in the input', () => {
    const pending = [n('a'), n('b'), n('c'), p('exec')];
    const results = assignLotteryResultsWithPriority(pending, 2);
    expect(statusOf(results, 'exec')).toBe('Invited');
    // Only 1 of 2 capacity slots is left for the 3 non-priority entrants.
    const nonPriorityInvited = results.filter(r => r.newStatus === 'Invited' && r.signup_id !== 'exec');
    expect(nonPriorityInvited).toHaveLength(1);
  });

  test('multiple priority entrants all win regardless of order', () => {
    const pending = [n('a'), p('exec1'), n('b'), p('exec2'), n('c')];
    const results = assignLotteryResultsWithPriority(pending, 1);
    expect(statusOf(results, 'exec1')).toBe('Invited');
    expect(statusOf(results, 'exec2')).toBe('Invited');
    // Capacity of 1 was entirely consumed by the 2 priority entrants, so
    // every non-priority entrant is waitlisted.
    expect(statusOf(results, 'a')).toBe('Waitlist');
    expect(statusOf(results, 'b')).toBe('Waitlist');
    expect(statusOf(results, 'c')).toBe('Waitlist');
  });

  test('priority entrants exceeding capacity ALL still win (capacity is exceeded, not them)', () => {
    const pending = [p('exec1'), p('exec2'), p('exec3'), n('a')];
    const results = assignLotteryResultsWithPriority(pending, 2);
    expect(statusOf(results, 'exec1')).toBe('Invited');
    expect(statusOf(results, 'exec2')).toBe('Invited');
    expect(statusOf(results, 'exec3')).toBe('Invited');
    expect(statusOf(results, 'a')).toBe('Waitlist');
    expect(results.filter(r => r.newStatus === 'Invited')).toHaveLength(3); // > capacity of 2
  });

  test('with no priority entrants, behaves exactly like assignLotteryResults', () => {
    const pending = [n('a'), n('b'), n('c')];
    const withPriority = assignLotteryResultsWithPriority(pending, 2)
      .sort((x, y) => x.signup_id.localeCompare(y.signup_id));
    const plain = assignLotteryResults(pending.map(({ signup_id }) => ({ signup_id })), 2)
      .sort((x, y) => x.signup_id.localeCompare(y.signup_id));
    expect(withPriority.map(r => ({ signup_id: r.signup_id, newStatus: r.newStatus })))
      .toEqual(plain.map(r => ({ signup_id: r.signup_id, newStatus: r.newStatus })));
  });

  test('with everyone priority, everyone wins even at zero capacity', () => {
    const results = assignLotteryResultsWithPriority([p('a'), p('b')], 0);
    expect(statusOf(results, 'a')).toBe('Invited');
    expect(statusOf(results, 'b')).toBe('Invited');
  });

  test('lottery_rank is unique 1..N across both groups combined', () => {
    const pending = [n('a'), p('exec'), n('b'), n('c')];
    const results = assignLotteryResultsWithPriority(pending, 2);
    const ranks = results.map(r => r.lottery_rank).sort((x, y) => x - y);
    expect(ranks).toEqual([1, 2, 3, 4]);
  });

  test('empty input returns empty output', () => {
    expect(assignLotteryResultsWithPriority([], 10)).toHaveLength(0);
  });
});

// ─── determineDeclineOutcome ──────────────────────────────────────────────────

describe('determineDeclineOutcome — flake vs drop', () => {
  // ── Invited declines ──────────────────────────────────────────────────────

  describe('Invited member declines', () => {
    test('within grace window (late) → Flaked with fee', () => {
      const signup   = { status: 'Invited', event_date: hoursFromNow(10) }; // 10 h away, < 24 h
      const { newStatus, feeAmount, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Flaked');
      expect(isLate).toBe(true);
      expect(feeAmount).toBe(30);
    });

    test('outside grace window (early) → Dropped, no fee consequence', () => {
      const signup = { status: 'Invited', event_date: hoursFromNow(48) }; // 48 h away, > 24 h
      const { newStatus, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
      expect(isLate).toBe(false);
    });

    test('exactly at grace boundary → not late (< not <=) → Dropped', () => {
      const graceMs = 24 * 60 * 60 * 1000;
      const now     = new Date();
      const signup  = { status: 'Invited', event_date: new Date(now.getTime() + graceMs) };
      const { newStatus, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, now);
      expect(newStatus).toBe('Dropped');
      expect(isLate).toBe(false);
    });

    test('1 ms inside grace window → Flaked', () => {
      const graceMs = 24 * 60 * 60 * 1000;
      const now     = new Date();
      const signup  = { status: 'Invited', event_date: new Date(now.getTime() + graceMs - 1) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, now);
      expect(newStatus).toBe('Flaked');
    });

    test('event already passed → isLate true → Flaked', () => {
      const signup = { status: 'Invited', event_date: hoursFromNow(-1) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Flaked');
    });

    test('custom grace window and fee amount are respected', () => {
      const settings = { decline_grace_window_hours: '48', flake_fee_amount: '50' };
      // 36 h away: inside 48 h window → Flaked with $50 fee
      const signup = { status: 'Invited', event_date: hoursFromNow(36) };
      const { newStatus, feeAmount } = determineDeclineOutcome(signup, settings, new Date());
      expect(newStatus).toBe('Flaked');
      expect(feeAmount).toBe(50);
    });
  });

  // ── Pending declines (before lottery — never Flaked regardless of timing) ──

  describe('Pending member declines (before lottery)', () => {
    test('late Pending decline → Dropped (not yet Invited → no flake)', () => {
      const signup = { status: 'Pending', event_date: hoursFromNow(1) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
    });

    test('early Pending decline → Dropped', () => {
      const signup = { status: 'Pending', event_date: hoursFromNow(100) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
    });
  });

  describe('Waitlist member declines', () => {
    test('late Waitlist decline → Dropped (not Flaked)', () => {
      const signup = { status: 'Waitlist', event_date: hoursFromNow(2) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
    });
  });

  // ── No event date ─────────────────────────────────────────────────────────

  test('no event_date → isLate is false → Dropped', () => {
    const signup = { status: 'Invited', event_date: null };
    const { newStatus, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
    expect(isLate).toBe(false);
    expect(newStatus).toBe('Dropped');
  });
});

// ─── shouldAutoPromote ────────────────────────────────────────────────────────

describe('shouldAutoPromote — auto-promotion eligibility', () => {
  test('Invited + auto_invite_enabled → promote', () => {
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: true })).toBe(true);
  });

  test('Invited + auto_invite_enabled false → do not promote', () => {
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: false })).toBe(false);
  });

  test('Pending + auto_invite_enabled → do not promote (not yet invited)', () => {
    expect(shouldAutoPromote({ status: 'Pending' }, { auto_invite_enabled: true })).toBe(false);
  });

  test('Waitlist + auto_invite_enabled → do not promote (only Invited slots trigger promotion)', () => {
    expect(shouldAutoPromote({ status: 'Waitlist' }, { auto_invite_enabled: true })).toBe(false);
  });

  test('Invited + auto_invite_enabled null/undefined → do not promote', () => {
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: null })).toBe(false);
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: undefined })).toBe(false);
  });
});

// ─── classifyFinalizeSignups ──────────────────────────────────────────────────

describe('classifyFinalizeSignups — Invited → Flaked, Waitlist → Lost', () => {
  test('classifies Invited and Waitlist correctly', () => {
    const signups = [
      { signup_id: 'a', status: 'Attended' },
      { signup_id: 'b', status: 'Invited' },
      { signup_id: 'c', status: 'Invited' },
      { signup_id: 'd', status: 'Waitlist' },
      { signup_id: 'e', status: 'Waitlist' },
      { signup_id: 'f', status: 'Waitlist' },
    ];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(2);
    expect(toLose).toHaveLength(3);
    // Attended is not touched
    expect(toFlake.some(s => s.signup_id === 'a')).toBe(false);
    expect(toLose.some(s => s.signup_id === 'a')).toBe(false);
  });

  test('all invited are classified for flaking', () => {
    const signups = [{ signup_id: '1', status: 'Invited' }, { signup_id: '2', status: 'Invited' }];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(2);
    expect(toLose).toHaveLength(0);
  });

  test('all waitlist are classified as lost', () => {
    const signups = [{ signup_id: '1', status: 'Waitlist' }, { signup_id: '2', status: 'Waitlist' }];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(0);
    expect(toLose).toHaveLength(2);
  });

  test('Attended, Dropped, and Flaked are not touched', () => {
    const signups = [
      { signup_id: 'a', status: 'Attended' },
      { signup_id: 'b', status: 'Dropped' },
      { signup_id: 'c', status: 'Flaked' },
    ];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(0);
    expect(toLose).toHaveLength(0);
  });

  test('empty signup list', () => {
    const { toFlake, toLose } = classifyFinalizeSignups([]);
    expect(toFlake).toHaveLength(0);
    expect(toLose).toHaveLength(0);
  });

  test('does not mutate input array', () => {
    const signups = [{ signup_id: 'x', status: 'Invited' }];
    classifyFinalizeSignups(signups);
    expect(signups[0].status).toBe('Invited'); // unchanged
  });

  test('correct signup_ids preserved in output', () => {
    const signups = [
      { signup_id: 'inv1', status: 'Invited' },
      { signup_id: 'wait1', status: 'Waitlist' },
    ];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake[0].signup_id).toBe('inv1');
    expect(toLose[0].signup_id).toBe('wait1');
  });
});

// ─── Payment clears balance and unblocks member ───────────────────────────────

describe('Payment clears balance and unblocks member', () => {
  test('full payment reduces balance to 0', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('partial payment leaves residual balance', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '20' },
    ];
    expect(computeBalance(ledger)).toBe(10);
  });

  test('payment unblocks: balance 0 → member should be Active (not Blocked)', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    const newBal = computeBalance(ledger);
    const newStatus = newBal <= 0 ? 'Active' : 'Blocked';
    expect(newStatus).toBe('Active');
  });

  test('partial payment does not unblock', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '10' },
    ];
    const newBal = computeBalance(ledger);
    const newStatus = newBal <= 0 ? 'Active' : 'Blocked';
    expect(newStatus).toBe('Blocked');
  });

  test('waiver also clears balance and unblocks', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Waiver', amount: '30' },
    ];
    const newBal = computeBalance(ledger);
    expect(newBal).toBe(0);
    expect(newBal <= 0 ? 'Active' : 'Blocked').toBe('Active');
  });

  test('multiple charges cleared by single payment', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '60' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });
});

// ─── Fee-blocked member cannot enter lottery ──────────────────────────────────

describe('Fee-blocked member cannot enter lottery', () => {
  test('member with positive balance is blocked', () => {
    expect(isMemberBlocked({ fee_balance: '30', status: 'Active' })).toBe(true);
  });

  test('member with Blocked status is blocked even with zero balance', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Blocked' })).toBe(true);
  });

  test('active member with zero balance can enter lottery', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Active' })).toBe(false);
  });

  test('paying fee clears block: balance goes to 0 → not blocked', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    const newBal = computeBalance(ledger);
    const memberAfterPayment = { fee_balance: newBal.toString(), status: 'Active' };
    expect(isMemberBlocked(memberAfterPayment)).toBe(false);
  });
});

// ─── canManualAddToEvent ─────────────────────────────────────────────────────

describe('canManualAddToEvent — Exec Team manual-add override', () => {
  const okMember = { fee_balance: '0', status: 'Active' };
  const openEvent = { status: 'Open' };

  test('allowed: no existing signup, event Open, member in good standing', () => {
    expect(canManualAddToEvent(openEvent, okMember, null)).toEqual({ ok: true });
  });

  test('allowed even after the lottery has run (event Lotteried)', () => {
    expect(canManualAddToEvent({ status: 'Lotteried' }, okMember, null)).toEqual({ ok: true });
  });

  test('allowed with Closed or Draft events too', () => {
    expect(canManualAddToEvent({ status: 'Closed' }, okMember, null).ok).toBe(true);
    expect(canManualAddToEvent({ status: 'Draft' }, okMember, null).ok).toBe(true);
  });

  test('rejected: event Completed', () => {
    const r = canManualAddToEvent({ status: 'Completed' }, okMember, null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/completed/i);
  });

  test('rejected: event Cancelled', () => {
    const r = canManualAddToEvent({ status: 'Cancelled' }, okMember, null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cancelled/i);
  });

  test('rejected: event not found', () => {
    expect(canManualAddToEvent(null, okMember, null)).toEqual({ ok: false, error: 'Event not found.' });
  });

  test('rejected: member not found', () => {
    const r = canManualAddToEvent(openEvent, null, null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/member not found/i);
  });

  test('rejected: blocked member (outstanding fee)', () => {
    const r = canManualAddToEvent(openEvent, { fee_balance: '30', status: 'Active' }, null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked/i);
  });

  test('rejected: blocked member (Blocked status, zero balance)', () => {
    const r = canManualAddToEvent(openEvent, { fee_balance: '0', status: 'Blocked' }, null);
    expect(r.ok).toBe(false);
  });

  test('rejected: already Invited', () => {
    const r = canManualAddToEvent(openEvent, okMember, { status: 'Invited' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already invited/i);
  });

  test('rejected: already Attended', () => {
    const r = canManualAddToEvent(openEvent, okMember, { status: 'Attended' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already attended/i);
  });

  test('allowed: existing Waitlist signup can be turned into an invite', () => {
    expect(canManualAddToEvent(openEvent, okMember, { status: 'Waitlist' })).toEqual({ ok: true });
  });

  test('allowed: existing Pending signup can be turned into an invite', () => {
    expect(canManualAddToEvent(openEvent, okMember, { status: 'Pending' }).ok).toBe(true);
  });

  test('allowed: existing Dropped/Flaked/Lost signup can be re-invited', () => {
    expect(canManualAddToEvent(openEvent, okMember, { status: 'Dropped' }).ok).toBe(true);
    expect(canManualAddToEvent(openEvent, okMember, { status: 'Flaked' }).ok).toBe(true);
    expect(canManualAddToEvent(openEvent, okMember, { status: 'Lost' }).ok).toBe(true);
  });
});

// ─── Birth-year verification ────────────────────────────────────────────────

describe('isValidBirthDateInput', () => {
  test('accepts a real past date', () => {
    expect(isValidBirthDateInput('1996-03-14')).toBe(true);
  });

  test('accepts today, rejects tomorrow', () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    expect(isValidBirthDateInput(todayStr)).toBe(true);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(isValidBirthDateInput(tomorrow)).toBe(false);
  });

  test('rejects wrong format', () => {
    expect(isValidBirthDateInput('03/14/1996')).toBe(false);
    expect(isValidBirthDateInput('1996-3-14')).toBe(false);
    expect(isValidBirthDateInput('')).toBe(false);
    expect(isValidBirthDateInput(null)).toBe(false);
    expect(isValidBirthDateInput(undefined)).toBe(false);
  });

  test('rejects calendar-invalid dates instead of silently rolling over', () => {
    expect(isValidBirthDateInput('1996-02-30')).toBe(false);
    expect(isValidBirthDateInput('1996-13-01')).toBe(false);
    expect(isValidBirthDateInput('1996-00-10')).toBe(false);
  });

  test('rejects absurdly old dates', () => {
    expect(isValidBirthDateInput('1899-12-31')).toBe(false);
    expect(isValidBirthDateInput('1900-01-01')).toBe(true);
  });
});

describe('isValidBirthYear', () => {
  test('accepts plausible past birth years', () => {
    expect(isValidBirthYear(1996)).toBe(true);
    expect(isValidBirthYear('1998')).toBe(true);
    expect(isValidBirthYear(1900)).toBe(true);
  });

  test('rejects non-integers, out-of-range and future years', () => {
    expect(isValidBirthYear(1899)).toBe(false);
    expect(isValidBirthYear(new Date().getUTCFullYear() + 1)).toBe(false);
    expect(isValidBirthYear('abc')).toBe(false);
    expect(isValidBirthYear(1996.5)).toBe(false);
    expect(isValidBirthYear(null)).toBe(false);
  });
});

describe('extractBirthYear', () => {
  test('extracts the year from a valid string', () => {
    expect(extractBirthYear('1996-03-14')).toBe(1996);
  });

  test('returns null for missing or malformed input', () => {
    expect(extractBirthYear(null)).toBeNull();
    expect(extractBirthYear(undefined)).toBeNull();
    expect(extractBirthYear('')).toBeNull();
    expect(extractBirthYear('not-a-date')).toBeNull();
    expect(extractBirthYear(1996)).toBeNull(); // must be the string form, not a number
  });
});

describe('hasBirthYearPriority', () => {
  test('true only when both the birth year matches AND an ID photo is on file', () => {
    expect(hasBirthYearPriority({ birth_date: '1996-03-14', has_id_photo: true }, 1996)).toBe(true);
  });

  test('false: matching year but no ID photo (self-report alone is not confirmation)', () => {
    expect(hasBirthYearPriority({ birth_date: '1996-03-14', has_id_photo: false }, 1996)).toBe(false);
  });

  test('false: photo on file but year does not match', () => {
    expect(hasBirthYearPriority({ birth_date: '1995-03-14', has_id_photo: true }, 1996)).toBe(false);
  });

  test('false: event has no birth-year priority configured', () => {
    expect(hasBirthYearPriority({ birth_date: '1996-03-14', has_id_photo: true }, null)).toBe(false);
  });

  test('false: no birth date on file at all', () => {
    expect(hasBirthYearPriority({ birth_date: null, has_id_photo: true }, 1996)).toBe(false);
  });

  test('false: member is null/undefined', () => {
    expect(hasBirthYearPriority(null, 1996)).toBe(false);
  });
});

describe('canRemoveFromInvited (non-exec 24h lockout)', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const inHours = h => new Date(now.getTime() + h * 3600e3);
  test('exec can always remove', () => {
    expect(canRemoveFromInvited({ isExec: true, eventDate: inHours(1), graceHours: 24, now })).toBe(true);
    expect(canRemoveFromInvited({ isExec: true, eventDate: inHours(-5), graceHours: 24, now })).toBe(true);
  });
  test('non-exec: allowed before the window, blocked from 24h out and after the start', () => {
    expect(canRemoveFromInvited({ isExec: false, eventDate: inHours(48), graceHours: 24, now })).toBe(true);
    expect(canRemoveFromInvited({ isExec: false, eventDate: inHours(24), graceHours: 24, now })).toBe(true);   // exactly 24h out
    expect(canRemoveFromInvited({ isExec: false, eventDate: inHours(23.9), graceHours: 24, now })).toBe(false);
    expect(canRemoveFromInvited({ isExec: false, eventDate: inHours(0), graceHours: 24, now })).toBe(false);
    expect(canRemoveFromInvited({ isExec: false, eventDate: inHours(-3), graceHours: 24, now })).toBe(false);
  });
  test('uses the configured grace window; defaults to 24; no date = allowed', () => {
    expect(canRemoveFromInvited({ isExec: false, eventDate: inHours(30), graceHours: '48', now })).toBe(false);
    expect(canRemoveFromInvited({ isExec: false, eventDate: inHours(23), now })).toBe(false);
    expect(canRemoveFromInvited({ isExec: false, eventDate: null, graceHours: 24, now })).toBe(true);
  });
});
