/*
 * Tairāwhiti Invest — versioning helpers (§3, §38.1)
 * --------------------------------------------------
 * Pure helpers that enforce "never erase history". Framework versions, thesis
 * versions and analysis snapshots are immutable rows; editing creates a NEW
 * version and supersedes the old one without mutating it. These functions return
 * new objects and never mutate their inputs, so the UI/db layer can rely on them.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Versioning = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function nowIso() {
    return new Date().toISOString();
  }

  // Deep clone via JSON (rows are plain data). Guarantees no shared references so
  // a new version can never mutate a prior one.
  function clone(x) {
    return x == null ? x : JSON.parse(JSON.stringify(x));
  }

  // Create the next framework version from a base, applying `changes`. The base
  // is returned untouched (immutability); the new version gets a fresh id and an
  // incremented version number and records what changed.
  function nextFrameworkVersion(base, changes, newId, at) {
    var prev = clone(base) || {};
    var next = clone(base) || {};
    next.id = newId;
    next.version = (prev.version || 0) + 1;
    next.previous_version_id = prev.id || null;
    next.created_at = at || nowIso();
    next.superseded_at = null;
    Object.keys(changes || {}).forEach(function (k) {
      next[k] = clone(changes[k]);
    });
    return { previous: prev, next: next };
  }

  // Supersede a row without destroying it: returns a copy stamped with
  // superseded_at. Callers persist this alongside the new active row.
  function supersede(row, at) {
    var c = clone(row) || {};
    c.superseded_at = at || nowIso();
    return c;
  }

  // Thesis version history. Adds a new version; prior versions are retained and
  // marked superseded. Returns { versions:[...], active } — inputs untouched.
  function addThesisVersion(existingVersions, newVersion, newId, at) {
    var stamp = at || nowIso();
    var versions = (existingVersions || []).map(function (v) {
      var c = clone(v);
      if (!c.superseded_at) c.superseded_at = stamp;
      return c;
    });
    var active = clone(newVersion) || {};
    active.id = newId;
    active.version = versions.length + 1;
    active.created_at = stamp;
    active.superseded_at = null;
    versions.push(active);
    return { versions: versions, active: active };
  }

  // A diff of two thesis versions' structured fields, for the "what changed" log.
  function thesisDiff(a, b) {
    a = a || {};
    b = b || {};
    var fields = [
      "fundamental_reason",
      "supporting_flow_condition",
      "main_risk",
      "thesis_type",
      "consensus_position",
      "portfolio_role",
      "intended_time_horizon",
      "narrative",
    ];
    var changed = {};
    fields.forEach(function (f) {
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
        changed[f] = { from: a[f] == null ? null : a[f], to: b[f] == null ? null : b[f] };
      }
    });
    return changed;
  }

  return {
    nowIso: nowIso,
    clone: clone,
    nextFrameworkVersion: nextFrameworkVersion,
    supersede: supersede,
    addThesisVersion: addThesisVersion,
    thesisDiff: thesisDiff,
  };
});
