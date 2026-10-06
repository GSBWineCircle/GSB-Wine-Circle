/** Pure helpers for presenting audit log rows. */

'use strict';

/**
 * Work out who an audit entry affected, if anyone. The route joins the live
 * signup/member rows (affected_name/affected_email); this falls back to what
 * the entry itself recorded, so entries about since-deleted rows (e.g. a
 * signup removed from the lottery, or deleted members) still say who.
 * @param {object} row audit_log row plus affected_name / affected_email / partner_name from the joins
 * @returns {{name: string, email: string, note: string}|null}
 */
function affectedFrom(row) {
  const before = row.before_state || {};
  const after = row.after_state || {};
  if (row.action === 'BulkDeleteMembers' && Array.isArray(before.deleted)) {
    const n = before.deleted.length;
    return { name: `${n} member${n === 1 ? '' : 's'}`, email: '', note: '' };
  }
  let name = row.affected_name || '';
  let email = row.affected_email || '';
  if (!name && !email) {
    // Snapshot fallback: signup rows carry member_name/member_email, member rows full_name/email.
    name = before.member_name || before.full_name || after.member_name || after.full_name || '';
    email = before.member_email || before.email || after.member_email || after.email || '';
  }
  if (!name && !email) return null;
  const note = row.partner_name ? `with ${row.partner_name}` : '';
  return { name, email, note };
}

module.exports = { affectedFrom };
