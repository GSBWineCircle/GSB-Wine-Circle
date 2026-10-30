/**
 * The members columns that are safe and cheap to select for general use: every
 * column EXCEPT the ID photo (a multi-MB BYTEA) and the birth date (Exec-only
 * data). `SELECT *` / `RETURNING *` on members used to pull the photo bytes on
 * every payment/edit/manual-add, wasting database egress, and PATCH /members/:id
 * even returned them to the caller and wrote them into the audit log.
 * Tested against schema.sql so a newly added column can't be forgotten.
 */

'use strict';

const MEMBER_COLS = [
  'member_id', 'email', 'full_name', 'affiliation', 'is_admin', 'is_exec_team', 'fee_balance', 'status',
  'date_joined', 'notes', 'exec_notes', 'partner_member_id', 'school_year', 'created_at', 'updated_at',
  'id_photo_content_type', 'id_photo_uploaded_at',
].join(', ');

module.exports = { MEMBER_COLS };
