/** GET    /api/profile/:id  — one profile, JSON arrays parsed to real arrays
 *  PUT    /api/profile/:id  — update; bumps `version` iff targeting changed
 *  DELETE /api/profile/:id  — refused for the default, and while it owns leads
 *
 *  Every handler here addresses one profile by id, so every one of them is the
 *  hole 010 describes: before ownership existed, any valid cookie plus any id
 *  read or rewrote that profile. `assertProfileOwner` runs FIRST in all three —
 *  before the body is parsed, before any count is taken — so a caller learns
 *  nothing from timing or from an error message about a profile that is not
 *  theirs. It answers 404 for "no such profile" and 403 for "not yours", which
 *  does distinguish existence; that is deliberate, since ids are sequential and
 *  already guessable, and a plain 404 everywhere would make a real
 *  mistyped-id bug indistinguishable from a permissions one.
 */
import { json, badRequest, notFound } from "../../lib/db.js";
import {
  rowToProfile,
  coerceField,
  targetingChanged,
  assertProfileOwner,
  WRITABLE_FIELDS,
  parseId,
} from "../../lib/profile.js";

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = parseId(params.id);
  if (!id) return badRequest("invalid profile id");

  // An admin may inspect any profile: DELETE below lets them remove one, and
  // being able to read what you are about to delete is the lesser power.
  const owner = await assertProfileOwner(env, id, context.data.userId, context.data.user?.is_admin);
  if (owner.error) return json({ error: owner.error }, { status: owner.status });

  const row = await env.DB.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM companies c WHERE c.profile_id = p.id) AS owned_leads,
           (SELECT COUNT(*) FROM profile_companies pc
              WHERE pc.profile_id = p.id
                AND NOT EXISTS (
                  SELECT 1 FROM companies c2
                   WHERE c2.id = pc.company_id AND c2.profile_id = p.id
                )) AS adopted_leads
      FROM profiles p WHERE p.id = ?1
  `).bind(id).first();
  if (!row) return notFound("profile not found");

  const out = rowToProfile(row);
  out.owned_leads = row.owned_leads || 0;
  out.adopted_leads = row.adopted_leads || 0;
  out.lead_count = out.owned_leads + out.adopted_leads;
  return json(out);
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const id = parseId(params.id);
  if (!id) return badRequest("invalid profile id");

  // NOT admin-bypassed, on purpose. Editing a profile rewrites the identity
  // and targeting its owner sends outreach under; that is impersonation, not
  // administration. An admin who must change someone's profile can delete it
  // or be given ownership — both are visible acts, unlike a silent edit.
  const owner = await assertProfileOwner(env, id, context.data.userId);
  if (owner.error) return json({ error: owner.error }, { status: owner.status });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected a JSON object");
  }

  const existing = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(id).first();
  if (!existing) return notFound("profile not found");

  const updates = {};
  for (const field of WRITABLE_FIELDS) {
    if (!(field in body)) continue;
    const { value, error } = coerceField(field, body[field]);
    if (error) return badRequest(error);
    updates[field] = value;
  }
  if ("name" in updates && !updates.name) return badRequest("name cannot be empty");

  const wantsDefault = body.is_default === 1 || body.is_default === true;
  if (!Object.keys(updates).length && !wantsDefault) {
    return badRequest("no profile fields to update");
  }

  // The whole point of `version`: a targeting edit changes which leads qualify
  // and how they grade, so leads judged before and after are not comparable.
  // An identity edit (new phone, new portfolio link) changes nothing about
  // judgement, so it must not invalidate 292 existing grades.
  const bumped = targetingChanged(existing, updates);
  const version = bumped ? existing.version + 1 : existing.version;
  const now = Date.now();

  const setCols = Object.keys(updates);
  const assignments = setCols.map((c, i) => `${c} = ?${i + 1}`);
  const binds = setCols.map((c) => updates[c]);
  assignments.push(`version = ?${binds.length + 1}`);
  binds.push(version);
  assignments.push(`updated_at = ?${binds.length + 1}`);
  binds.push(now);

  const statements = [
    env.DB.prepare(`UPDATE profiles SET ${assignments.join(", ")} WHERE id = ?${binds.length + 1}`)
      .bind(...binds, id),
  ];

  // Exactly one row may hold is_default = 1. Clearing the others first and
  // setting this one second, inside one batch, keeps that true.
  if (wantsDefault) {
    statements.push(env.DB.prepare("UPDATE profiles SET is_default = 0 WHERE id != ?1").bind(id));
    statements.push(env.DB.prepare("UPDATE profiles SET is_default = 1 WHERE id = ?1").bind(id));
  } else if (body.is_default === 0 || body.is_default === false) {
    // Refused rather than silently ignored: dropping the flag with no
    // replacement would leave the app with no default profile at all.
    if (existing.is_default) {
      return badRequest("cannot unset the default profile — set is_default on another profile instead");
    }
  }

  await env.DB.batch(statements);

  const row = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(id).first();
  const out = rowToProfile(row);
  out.version_bumped = bumped;
  out.changed_fields = setCols;
  return json(out);
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = parseId(params.id);
  if (!id) return badRequest("invalid profile id");

  // Admin-bypassed: removing a departed tenant's profile is exactly the job
  // an administrator exists for. The refusals below (default profile, still
  // owns leads) still apply to them — they guard data, not ownership.
  const owner = await assertProfileOwner(env, id, context.data.userId, context.data.user?.is_admin);
  if (owner.error) return json({ error: owner.error }, { status: owner.status });

  const existing = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(id).first();
  if (!existing) return notFound("profile not found");

  // Both refusals are 409s with a sentence a user can act on, not a 500 from a
  // foreign-key blow-up further down.
  if (existing.is_default) {
    return json(
      { error: "cannot delete the default profile — make another profile the default first" },
      { status: 409 }
    );
  }

  const owned = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM companies WHERE profile_id = ?1")
    .bind(id)
    .first();
  if ((owned?.n || 0) > 0) {
    return json(
      {
        error: `cannot delete profile ${id} — it still owns ${owned.n} lead(s). Reassign or delete them first.`,
        owned_leads: owned.n,
      },
      { status: 409 }
    );
  }

  // Since migration 008 a profile also owns `progress` and `stage_history`
  // rows. Those are keyed by (profile_id, company_id) with no foreign key to
  // `profiles`, so nothing would clean them up: they would sit there until a
  // future profile was handed the same autoincrement id and inherited a dead
  // profile's stages. The refusals above already guarantee this profile owns
  // no companies, so these deletes only ever touch adopted-lead progress.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM progress WHERE profile_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM stage_history WHERE profile_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM profile_companies WHERE profile_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM profiles WHERE id = ?1").bind(id),
  ]);
  return json({ ok: true, deleted: id });
}
