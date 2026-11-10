// ==UserScript==
// @name         Canvas Report Card
// @namespace    canvas-report-card
// @version      2.1
// @description  One screen with every class grade, missing work, teacher comments and per-class targets.
// @match        https://*.instructure.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// If your school's Canvas lives on its own domain (e.g. canvas.myschool.org),
// add another line above:   // @match https://canvas.myschool.org/*

(function () {
  'use strict';
  const VERSION = '2.1'; // keep in sync with @version
  console.log('[crc] v' + VERSION + ' script started', location.href, window.top === window.self ? '(top frame)' : '(iframe, skipping)');
  if (window.top !== window.self) return;

  const API = location.origin + '/api/v1';
  const REFRESH_MS = 5 * 60 * 1000;
  const LS = 'crc:';

  // ---------- data ----------
  async function getAll(path, params = {}) {
    const u = new URL(API + path);
    u.searchParams.set('per_page', '100');
    for (const [k, v] of Object.entries(params))
      (Array.isArray(v) ? v : [v]).forEach(x => u.searchParams.append(k, x));
    let url = u.toString();
    const out = [];
    while (url) {
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`${r.status} on ${path}`);
      const d = JSON.parse((await r.text()).replace(/^while\(1\);/, ''));
      Array.isArray(d) ? out.push(...d) : out.push(d);
      const m = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }

  async function loadStudents() {
    let obs = [];
    try { obs = await getAll('/users/self/observees'); } catch (e) { /* not an observer */ }
    if (obs.length) return obs.map(s => ({ id: s.id, name: s.short_name || s.name }));
    const me = (await getAll('/users/self'))[0];
    return [{ id: me.id, name: me.short_name || me.name }];
  }

  // Work a student can turn in online. Paper, in-class and "not graded" items just wait for the teacher.
  const SUBMITTABLE = /^(online_|external_tool|media_recording|student_annotation|discussion_topic)/;

  function statusOf(s) {
    const a = s.assignment || {};
    if (s.excused) return 'excused';
    if (s.missing) return 'MISSING';
    if (s.score != null) return s.late ? 'late' : 'graded';
    if (s.submitted_at) return 'awaiting grade';
    if (a.due_at && new Date(a.due_at) > new Date()) return 'upcoming';
    if (!a.due_at) return 'no due date';
    if (!(a.points_possible > 0) || !(a.submission_types || []).some(t => SUBMITTABLE.test(t))) return 'not graded yet';
    return 'not submitted';
  }

  // `known` is the course from the favorites call. Observers get 403 on /courses/:id for most
  // classes, so only call it (and assignment_groups) for courses we could already name.
  async function loadCourse(sid, e, known) {
    const cid = e.course_id;
    const [course, groups, subs] = await Promise.all([
      known
        ? getAll(`/courses/${cid}`, { 'include[]': 'teachers' }).then(x => ({ ...known, ...x[0] })).catch(() => known)
        : Promise.resolve({ name: `Course ${cid}` }),
      known ? getAll(`/courses/${cid}/assignment_groups`).catch(() => []) : Promise.resolve([]),
      getAll(`/courses/${cid}/students/submissions`, {
        'student_ids[]': sid, 'include[]': ['assignment', 'submission_comments'],
      }).catch(() => []),
    ]);
    const items = subs
      .filter(s => s.assignment && s.assignment.published !== false && !s.assignment.omit_from_final_grade)
      .map(s => {
        const a = s.assignment, poss = a.points_possible || 0;
        return {
          name: a.name, url: a.html_url, group: a.assignment_group_id, types: a.submission_types || [], gtype: a.grading_type,
          doneAt: s.submitted_at ? new Date(s.submitted_at) : s.score != null ? new Date(s.graded_at || a.due_at || Date.now()) : null,
          due: a.due_at ? new Date(a.due_at) : null,
          score: s.score, poss,
          pct: s.score != null && poss ? (100 * s.score) / poss : null,
          status: statusOf(s),
          comments: (s.submission_comments || [])
            .filter(c => c.author_id !== sid)
            .map(c => ({ who: c.author_name, text: c.comment, at: new Date(c.created_at) })),
        };
      })
      .sort((a, b) => (b.due || 0) - (a.due || 0));
    const g = e.grades || {};
    return {
      cid, name: course.name, items, groups,
      teacher: (course.teachers || []).map(t => t.display_name).join(', '),
      weighted: !!course.apply_assignment_group_weights,
      official: g.current_score ?? null,
      letter: g.current_grade || null,
    };
  }

  // ---------- grade math ----------
  // Recomputes the grade from assignments; fillPct treats MISSING work as turned in at that %.
  function calc(c, fillPct) {
    const g = {};
    for (const it of c.items) {
      if (it.status === 'excused') continue;
      let score = it.score;
      if (fillPct != null && it.status === 'MISSING') score = (it.poss * fillPct) / 100;
      if (score == null) continue;
      const k = c.weighted ? it.group : 'all';
      g[k] = g[k] || { s: 0, p: 0 };
      g[k].s += score; g[k].p += it.poss;
    }
    if (!c.weighted) return g.all && g.all.p ? (100 * g.all.s) / g.all.p : null;
    let tot = 0, w = 0;
    for (const gr of c.groups) {
      const x = g[gr.id];
      if (x && x.p) { tot += (gr.group_weight * x.s) / x.p; w += gr.group_weight; }
    }
    return w ? (100 * tot) / w : null;
  }
  // Applies the change to Canvas's official % so we stay consistent with what Canvas shows.
  function project(c, p) {
    const base = calc(c, null), f = calc(c, p);
    if (f == null) return null;
    return c.official != null && base != null ? c.official + (f - base) : f;
  }
  const letterOf = p => p == null ? '—' :
    p >= 93 ? 'A' : p >= 90 ? 'A-' : p >= 87 ? 'B+' : p >= 83 ? 'B' : p >= 80 ? 'B-' :
    p >= 77 ? 'C+' : p >= 73 ? 'C' : p >= 70 ? 'C-' : p >= 67 ? 'D+' : p >= 60 ? 'D' : 'F';
  const tone = p => p == null ? 'na' : p >= 90 ? 'a' : p >= 80 ? 'b' : p >= 70 ? 'c' : 'f';
  const f1 = n => n == null ? '—' : n.toFixed(1);

  function advice(c, t) {
    if (t == null) return 'Set a target to see what it takes.';
    if (c.official == null) return 'No graded work yet.';
    if (c.official >= t) return `✅ On target (+${(c.official - t).toFixed(1)}).`;
    const nm = c.items.filter(i => i.status === 'MISSING').length;
    const gap = (t - c.official).toFixed(1);
    if (!nm) return `${gap} pts short. No missing work to recover, so upcoming scores need to be higher.`;
    const best = project(c, 100);
    if (best == null || best < t)
      return `Even 100% on all ${nm} missing assignment(s) only reaches ${f1(best)}%. Upcoming work must be higher too.`;
    let lo = 0, hi = 100;
    for (let i = 0; i < 25; i++) { const m = (lo + hi) / 2; project(c, m) >= t ? (hi = m) : (lo = m); }
    return `Turn in the ${nm} missing assignment(s) averaging ${Math.ceil(hi)}% → reaches ${t}%.`;
  }

  // ---------- state ----------
  const S = { students: [], sid: null, data: null, loading: false, err: null, tab: 'classes', open: new Set(), at: null };
  const tKey = cid => `${LS}${S.sid}:${cid}`;
  const getTarget = cid => { try { const v = localStorage.getItem(tKey(cid)); return v ? +v : null; } catch { return null; } };
  const setTarget = (cid, v) => { try { v ? localStorage.setItem(tKey(cid), v) : localStorage.removeItem(tKey(cid)); } catch {} };

  async function load() {
    S.loading = true; S.err = null; render();
    try {
      if (!S.students.length) {
        S.students = await loadStudents();
        let saved = null; try { saved = localStorage.getItem(LS + 'sid'); } catch {}
        S.sid = (S.students.find(s => String(s.id) === saved) || S.students[0]).id;
      }
      const enr = await getAll(`/users/${S.sid}/enrollments`, { 'state[]': 'active', 'type[]': 'StudentEnrollment' });
      const seen = new Set();
      const uniq = enr.filter(e => !seen.has(e.course_id) && seen.add(e.course_id));
      // same call Canvas's own dashboard makes for an observer; the only source of course names
      const fav = await getAll('/users/self/favorites/courses', { 'include[]': ['term', 'teachers'], observed_user_id: S.sid }).catch(() => []);
      const names = new Map(fav.map(c => [c.id, c]));
      // Canvas keeps last year's enrollments "active". Keep a course if the dashboard lists it
      // (current term) or its enrollment is recent; fall back to everything if that leaves nothing.
      const RECENT = Date.now() - 300 * 864e5;
      let current = uniq.filter(e => names.has(e.course_id) || new Date(e.created_at) > RECENT);
      if (!current.length) current = uniq;
      const all = await Promise.all(current.map(e => loadCourse(S.sid, e, names.get(e.course_id))));
      // also hide current enrollments with no assignments and no grade (clubs, homerooms, empty shells)
      S.data = all.filter(c => c.items.length || c.official != null);
      S.hidden = uniq.length - S.data.length;
      S.at = new Date();
    } catch (e) {
      S.err = e.message;
    }
    S.loading = false; render();
  }

  // ---------- view ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const dt = d => d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
  const chip = st => `<span class="chip ${st === 'MISSING' ? 'bad' : st === 'late' ? 'warn' : st === 'graded' ? 'ok' : ''}">${esc(st)}</span>`;

  function header() {
    const d = S.data || [];
    const graded = d.filter(c => c.official != null);
    const avg = graded.length ? graded.reduce((a, c) => a + c.official, 0) / graded.length : null;
    const all = d.flatMap(c => c.items);
    const missing = all.filter(i => i.status === 'MISSING').length;
    const late = all.filter(i => i.status === 'late').length;
    const now = Date.now(), cut = now - 14 * 864e5;
    const sc = all.filter(i => i.pct != null && i.due && i.due <= now);
    // weight by points (total score / total possible) so tiny assignments don't dominate
    const avgOf = a => { const p = a.reduce((s, i) => s + i.poss, 0); return p ? (100 * a.reduce((s, i) => s + i.score, 0)) / p : null; };
    const recent = avgOf(sc.filter(i => i.due >= cut)), before = avgOf(sc.filter(i => i.due < cut));
    const arrow = recent == null || before == null ? '' : recent > before + 2 ? ' ▲' : recent < before - 2 ? ' ▼' : ' ▶';
    const pick = S.students.length > 1
      ? `<select data-act="student">${S.students.map(s => `<option value="${s.id}" ${s.id === S.sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
      : `<b>${esc((S.students[0] || {}).name || '')}</b>`;
    return `
      <div class="top">
        <div class="title">📊 Report card · ${pick} <small class="ver">v${VERSION}</small></div>
        <div class="btns noprint">
          <button data-act="refresh">↻ Refresh</button><button data-act="print">🖨 Print</button><button data-act="close">✕</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat ${tone(avg)}"><span>${f1(avg)}%</span><small>Average across classes (${letterOf(avg)})</small></div>
        <div class="stat ${missing ? 'f' : 'a'}"><span>${missing}</span><small>Missing assignments</small></div>
        <div class="stat ${late ? 'c' : 'a'}"><span>${late}</span><small>Turned in late</small></div>
        <div class="stat ${tone(recent)}"><span>${f1(recent)}%${arrow}</span><small>Last 2 weeks avg (before: ${f1(before)}%)</small></div>
      </div>
      <div class="sub">${S.loading ? 'Loading…' : S.at ? 'Updated ' + S.at.toLocaleTimeString() + ' · refreshes every 5 min while open' : ''}${S.hidden ? ` · ${S.hidden} older or empty course(s) hidden` : ''}${S.err ? ` · <span class="err">Error: ${esc(S.err)}</span>` : ''}</div>
      <div class="tabs noprint">
        ${['classes', 'upcoming', 'missing', 'comments'].map(t => `<button data-act="tab" data-tab="${t}" class="${S.tab === t ? 'on' : ''}">${{ classes: 'Classes', upcoming: 'Upcoming', missing: 'Missing work', comments: 'Teacher comments' }[t]}</button>`).join('')}
      </div>`;
  }

  function classesView() {
    const d = [...S.data].sort((a, b) => (a.official ?? 999) - (b.official ?? 999));
    if (!d.length) return '<p>No active classes found.</p>';
    return '<div class="grid">' + d.map(c => {
      const t = getTarget(c.cid);
      const miss = c.items.filter(i => i.status === 'MISSING');
      const late = c.items.filter(i => i.status === 'late').length;
      // upcoming = not due yet and not turned in; "this week" runs to the end of Sunday
      const d0 = sod(new Date()), wkEnd = dayAt(d0, 7 - ((d0.getDay() + 6) % 7));
      const up = c.items.filter(i => i.status === 'upcoming' && i.due && counts(i));
      const nWeek = up.filter(i => i.due < wkEnd).length;
      const nToday = up.filter(i => i.due < dayAt(d0, 1)).length;
      const nTomorrow = up.filter(i => i.due >= dayAt(d0, 1) && i.due < dayAt(d0, 2)).length;
      const p100 = miss.length ? project(c, 100) : null;
      const pct = Math.max(0, Math.min(100, c.official ?? 0));
      const open = S.open.has(c.cid);
      return `
      <div class="card ${tone(c.official)}${open ? ' open' : ''}">
        <div class="row1">
          <div><div class="cname">${esc(c.name)}</div><div class="teacher">${esc(c.teacher)}</div></div>
          <div class="big">${f1(c.official)}%<small>${esc(c.letter || letterOf(c.official))}</small></div>
        </div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div>${t ? `<div class="tgt" style="left:${Math.min(100, t)}%" title="Target ${t}%"></div>` : ''}</div>
        <div class="meta">
          <label>Target <input type="number" min="0" max="110" step="1" data-act="target" data-cid="${c.cid}" value="${t ?? ''}" placeholder="—">%</label>
          <span>Missing: <b class="${miss.length ? 'redt' : ''}">${miss.length}</b></span>
          <span>Late: <b>${late}</b></span>
          <span>Upcoming this week: <b>${nWeek}</b>${nToday ? ` <span class="pill d0">${nToday} today</span>` : ''}${nTomorrow ? ` <span class="pill d1">${nTomorrow} tomorrow</span>` : ''}</span>
          ${p100 != null ? `<span>If all missing done at 100%: <b>${f1(p100)}%</b></span>` : ''}
        </div>
        <div class="advice">${advice(c, t)}</div>
        <button class="link noprint" data-act="toggle" data-cid="${c.cid}">${open ? '▾ Hide' : '▸ Show'} assignments (${c.items.length})</button>
        ${open ? assignTable(c.items) : ''}
      </div>`;
    }).join('') + '</div>';
  }

  function assignTable(items, withCourse) {
    return `<table><thead><tr>${withCourse ? '<th>Class</th>' : ''}<th>Assignment</th><th>Due</th><th>Score</th><th>%</th><th>Status</th></tr></thead><tbody>
      ${items.map(i => `
        <tr class="${i.status === 'MISSING' ? 'missrow' : ''}">
          ${withCourse ? `<td>${esc(i.course)}</td>` : ''}
          <td><a href="${esc(i.url)}" target="_blank">${esc(i.name)}</a></td>
          <td>${dt(i.due)}</td>
          <td>${i.score != null ? `${+i.score.toFixed(2)} / ${i.poss}` : `— / ${i.poss}`}</td>
          <td class="${'t' + tone(i.pct)}">${i.pct != null ? Math.round(i.pct) + '%' : ''}${i.pct > 100 ? ' <span title="Above max points (extra credit)">★</span>' : ''}</td>
          <td>${chip(i.status)}</td>
        </tr>
        ${i.comments.length ? `<tr class="cm"><td colspan="${withCourse ? 6 : 5}">${i.comments.map(c => `💬 <b>${esc(c.who)}</b> (${dt(c.at)}): ${esc(c.text)}`).join('<br>')}</td></tr>` : ''}
      `).join('')}</tbody></table>`;
  }

  function missingView() {
    const pick = st => S.data.flatMap(c => c.items.filter(i => i.status === st).map(i => ({ ...i, course: c.name })))
      .sort((a, b) => (a.due || 0) - (b.due || 0));
    const pts = a => a.reduce((s, i) => s + i.poss, 0);
    const miss = pick('MISSING'), maybe = pick('not submitted');
    const waiting = S.data.reduce((n, c) => n + c.items.filter(i => i.status === 'not graded yet').length, 0);
    return (miss.length
        ? `<p>${miss.length} flagged missing by Canvas, worth ${pts(miss)} points. Oldest first.</p>${assignTable(miss, true)}`
        : '<p class="good">🎉 Nothing flagged missing.</p>')
      + (maybe.length
        ? `<h3>Past due, not flagged by Canvas (${maybe.length} · ${pts(maybe)} pts)</h3><p class="sub">Online work with no submission and no score. Worth a look.</p>${assignTable(maybe, true)}`
        : '')
      + (waiting ? `<p class="sub">${waiting} other past-due item(s) are paper, in-class or ungraded work waiting for the teacher to enter a score. Not counted as missing.</p>` : '');
  }

  // ---------- upcoming ----------
  const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const dayLabel = d => {
    const n = Math.round((sod(d) - sod(new Date())) / 864e5);
    return (n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'long' })) +
      ' · ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // Worth tracking as "to do": worth points, or something a student turns in. Ungraded placeholders aren't.
  const counts = i => i.poss > 0 || (i.types || []).some(t => SUBMITTABLE.test(t) || t === 'on_paper');
  const ptsLabel = i => i.poss > 0 ? i.poss : i.gtype === 'not_graded' ? 'not graded' : i.gtype === 'pass_fail' ? 'pass/fail' : '0';

  const daysLeft = (due, today) => {
    const n = Math.round((sod(due) - today) / 864e5);
    return n <= 0 ? '<b>today</b>' : n === 1 ? 'tomorrow' : `${n} days`;
  };

  // Burndown for the current school week, in COUNTS of assignments (not minutes).
  //   left    = assignments due this week that aren't turned in or graded yet (drawn up to now)
  //   not due = assignments whose due date is still ahead; steps down at the end of each due day.
  //             "left" sitting above it means something is past due and not done.
  //   ideal   = an even burn from the week's total down to zero
  const dayAt = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  function burndown(all) {
    const now = new Date(), today = sod(now);
    const mon = dayAt(today, -((today.getDay() + 6) % 7));
    const idx = i => Math.round((sod(i.due) - mon) / 864e5);
    const wk = all.filter(i => i.due && i.status !== 'excused' && counts(i) && idx(i) >= 0 && idx(i) < 7);
    if (!wk.length) return '<div class="card bd"><div class="cname">This week</div><p class="bd-head">No assignments due this week.</p></div>';
    const cols = wk.some(i => idx(i) >= 5) ? 7 : 5;      // Mon-Fri, or the whole week if something is due on a weekend
    const M = wk.length;
    const doneBy = t => wk.filter(i => i.doneAt && i.doneAt < t).length;

    const W = 720, H = 170, X0 = 44, X1 = 708, Y0 = 10, Y1 = 140;
    const step = M <= 5 ? 1 : M <= 10 ? 2 : M <= 25 ? 5 : 10;
    const yMax = Math.max(step, Math.ceil(M / step) * step);
    const xk = k => X0 + (k * (X1 - X0)) / cols;
    const yv = v => Y1 - (v / yMax) * (Y1 - Y0);
    const xNow = Math.max(0, Math.min(cols, (now - mon) / 864e5));
    const leftNow = M - doneBy(now);

    const pts = [];
    for (let k = 0; k <= cols; k++) {
      const start = dayAt(mon, k);
      const a = start <= now ? M - doneBy(start) : null;
      const ideal = (M * (cols - k)) / cols;
      const nd = M - wk.filter(i => idx(i) < k).length;
      pts.push({ x: xk(k), a, ya: a == null ? null : yv(a), i: ideal, yi: yv(ideal), nd, ynd: yv(nd),
        n: k ? wk.filter(i => idx(i) === k - 1).length : 0,
        label: k ? 'End of ' + dayLabel(dayAt(mon, k - 1)) : 'Start of week' });
    }

    let ndPath = `M${xk(0)},${yv(M)}`;
    for (let k = 1; k <= cols; k++) ndPath += ` H${xk(k)} V${pts[k].ynd}`;
    let aPath = '';
    pts.forEach(p => { if (p.a != null) aPath += (aPath ? ' L' : 'M') + `${p.x},${p.ya}`; });
    aPath += ` L${xk(xNow)},${yv(leftNow)}`;
    const idealPath = `M${xk(0)},${yv(M)} L${xk(cols)},${yv(0)}`;

    const overdue = wk.filter(i => i.due < now && !(i.doneAt && i.doneAt <= now)).length;
    const soon = wk.filter(i => i.due >= now && i.due < dayAt(today, 2)).length;
    const head = `This week: ${M} assignment${M === 1 ? '' : 's'} · ${M - leftNow} done · ${leftNow} left`
      + (overdue ? ` · ⚠ ${overdue} past due and not done` : '') + (soon ? ` · ${soon} due today or tomorrow` : '');

    const grid = [];
    for (let v = 0; v <= yMax; v += step)
      grid.push(`<line x1="${X0}" x2="${X1}" y1="${yv(v)}" y2="${yv(v)}" stroke="${v ? '#e1e0d9' : '#c3c2b7'}" stroke-width="1"/>`
        + `<text x="${X0 - 6}" y="${yv(v) + 4}" text-anchor="end" font-size="11" fill="#898781">${v}</text>`);
    const xlab = [];
    for (let k = 0; k < cols; k++) {
      const d = dayAt(mon, k);
      xlab.push(`<text x="${(xk(k) + xk(k + 1)) / 2}" y="${Y1 + 16}" text-anchor="middle" font-size="11" fill="#898781">${sod(d).getTime() === today.getTime() ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.getDate()}</text>`);
    }
    const dot = (cls, x, y, c) => `<circle class="${cls}" cx="${x}" cy="${y}" r="4" fill="${c}" stroke="#fff" stroke-width="2"/>`;
    const line = (d, c, w) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;

    return `
    <div class="card bd" data-pts="${esc(JSON.stringify(pts))}" data-k="0">
      <div class="cname">Week burndown <small class="ver">assignments due this week (ungraded placeholders not counted)</small></div>
      <p class="bd-head">${esc(head)}</p>
      <div class="bd-legend">
        <span><i class="ln c1"></i>Left to do</span>
        <span><i class="ln c2"></i>Not due yet</span>
        <span><i class="ln c3"></i>Ideal pace</span>
      </div>
      <div class="bd-plot">
        <svg viewBox="0 0 ${W} ${H}" tabindex="0" role="img" aria-label="${esc(head)}">
          ${grid.join('')}${xlab.join('')}
          ${line(idealPath, '#898781', 2)}${line(ndPath, '#eb6834', 2)}${line(aPath, '#2a78d6', 2)}
          ${dot('', xk(xNow), yv(leftNow), '#2a78d6')}
          <line class="bd-x" y1="${Y0}" y2="${Y1}" stroke="#c3c2b7" stroke-width="1" visibility="hidden"/>
          ${dot('bd-d3', -10, -10, '#898781')}${dot('bd-d2', -10, -10, '#eb6834')}${dot('bd-d1', -10, -10, '#2a78d6')}
        </svg>
        <div class="bd-tip" hidden>
          <b class="t"></b>
          <div class="row"><i class="c1"></i><b class="v1"></b><span>left to do</span></div>
          <div class="row"><i class="c2"></i><b class="v2"></b><span>not due yet</span></div>
          <div class="row"><i class="c3"></i><b class="v3"></b><span>ideal pace</span></div>
          <span class="due"></span>
        </div>
      </div>
      <details class="noprint"><summary>Table view</summary>
        <table>
          <thead><tr><th>Day</th><th>Due that day</th><th>Left to do</th><th>Not due yet</th><th>Ideal pace</th></tr></thead>
          <tbody>${pts.slice(1).map(p => `<tr><td>${esc(p.label.replace('End of ', ''))}</td><td>${p.n}</td><td>${p.a == null ? '—' : p.a}</td><td>${p.nd}</td><td>${Math.round(p.i * 10) / 10}</td></tr>`).join('')}</tbody>
        </table>
      </details>
    </div>`;
  }

  function bdShow(bd, k) {
    const pts = JSON.parse(bd.dataset.pts);
    k = Math.max(0, Math.min(pts.length - 1, k));
    const p = pts[k], q = s => bd.querySelector(s), at = (s, x, y) => { q(s).setAttribute('cx', x); q(s).setAttribute('cy', y); };
    bd.dataset.k = k;
    const x = q('.bd-x'); x.setAttribute('x1', p.x); x.setAttribute('x2', p.x); x.setAttribute('visibility', 'visible');
    at('.bd-d1', p.a == null ? -10 : p.x, p.a == null ? -10 : p.ya);
    at('.bd-d2', p.x, p.ynd);
    at('.bd-d3', p.x, p.yi);
    q('.bd-tip .t').textContent = p.label;
    q('.bd-tip .v1').textContent = p.a == null ? '—' : p.a;
    q('.bd-tip .v2').textContent = p.nd;
    q('.bd-tip .v3').textContent = Math.round(p.i * 10) / 10;
    q('.bd-tip .due').textContent = p.n ? `${p.n} due that day` : '';
    const tip = q('.bd-tip'), r = q('svg').getBoundingClientRect(), px = (p.x / 720) * r.width;
    tip.hidden = false;
    tip.style.left = (px > r.width - 200 ? px - 190 : px + 12) + 'px';
  }
  function bdHide(bd) {
    bd.querySelector('.bd-x').setAttribute('visibility', 'hidden');
    bd.querySelector('.bd-tip').hidden = true;
    ['.bd-d1', '.bd-d2', '.bd-d3'].forEach(s => bd.querySelector(s).setAttribute('cx', -10));
  }

  function upcomingView() {
    const upc = S.data.flatMap(c => c.items.filter(i => i.status === 'upcoming' && i.due).map(i => ({ ...i, course: c.name })));
    const items = upc.filter(counts).sort((a, b) => a.due - b.due);
    const skipped = upc.length - items.length;
    const all = S.data.flatMap(c => c.items);
    if (!items.length) return burndown(all) + '<p class="good">Nothing upcoming.</p>';

    const today = sod(new Date());
    const within = n => items.filter(i => i.due < today.getTime() + n * 864e5);
    const w1 = within(1), w3 = within(3), w7 = within(7);
    const stat = (v, l, t) => `<div class="stat ${t}"><span>${v}</span><small>${l}</small></div>`;

    const days = new Map();
    items.forEach(i => { const k = sod(i.due).getTime(); if (!days.has(k)) days.set(k, []); days.get(k).push(i); });

    return burndown(all) + `<div class="stats">
        ${stat(w1.length, 'Due today', w1.length ? 'c' : 'a')}
        ${stat(w3.length, 'Due in next 3 days', w3.length > 5 ? 'f' : w3.length > 2 ? 'c' : 'a')}
        ${stat(w7.length, 'Due in next 7 days', 'b')}
        ${stat(items.length, 'Upcoming in total', 'b')}
      </div>` + [...days].map(([k, arr]) => `
      <div class="card day${Math.round((k - today) / 864e5) <= 0 ? ' d0' : Math.round((k - today) / 864e5) === 1 ? ' d1' : ''}">
        <div class="cname">${esc(dayLabel(new Date(k)))} <small class="ver">${arr.length} due</small></div>
        <table>
          <colgroup><col style="width:80px"><col style="width:100px"><col style="width:22%"><col><col style="width:100px"></colgroup>
          <thead><tr>
            <th>Due at</th><th>Days left</th><th>Class</th><th>Assignment</th>
            <th title="Points possible: the most this is worth in the grade. 'not graded' or 0 means it adds no points (practice, pass/fail, in-class placeholder or extra credit).">Points</th>
          </tr></thead>
          <tbody>${arr.map(i => `
          <tr>
            <td>${i.due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
            <td>${daysLeft(i.due, today)}</td>
            <td>${esc(i.course)}</td>
            <td><a href="${esc(i.url)}" target="_blank">${esc(i.name)}</a></td>
            <td>${ptsLabel(i)}</td>
          </tr>`).join('')}</tbody></table>
      </div>`).join('') + (skipped ? `<p class="sub">${skipped} upcoming item(s) not shown: ungraded placeholders worth no points that can't be turned in.</p>` : '');
  }

  function commentsView() {
    const cs = S.data.flatMap(c => c.items.flatMap(i => i.comments.map(m => ({ ...m, course: c.name, item: i }))))
      .sort((a, b) => b.at - a.at);
    if (!cs.length) return '<p>No teacher comments yet.</p>';
    return cs.map(m => `
      <div class="comment">
        <div class="chead"><b>${esc(m.course)}</b> · <a href="${esc(m.item.url)}" target="_blank">${esc(m.item.name)}</a>
          ${m.item.pct != null ? ` · <span class="${'t' + tone(m.item.pct)}">${Math.round(m.item.pct)}%</span>` : ''} ${chip(m.item.status)}</div>
        <div class="ctext">${esc(m.text)}</div>
        <div class="cwho">— ${esc(m.who)}, ${dt(m.at)}</div>
      </div>`).join('');
  }

  function render() {
    const ov = root.querySelector('.ov');
    if (ov.hidden) return;
    const body = !S.data ? (S.loading ? '<p>Loading grades…</p>' : '')
      : S.tab === 'classes' ? classesView() : S.tab === 'upcoming' ? upcomingView() : S.tab === 'missing' ? missingView() : commentsView();
    ov.innerHTML = `<div class="wrap">${header()}<div class="body">${body}</div></div>`;
  }

  // ---------- shell ----------
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .fab{position:fixed;right:20px;bottom:20px;z-index:99999;padding:12px 18px;border:0;border-radius:24px;background:#1f3a5f;color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
    .ov{position:fixed;inset:0;z-index:100000;background:#f4f6f9;overflow:auto;color:#1c2430}
    .wrap{max-width:1400px;margin:0 auto;padding:20px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:12px}
    .title{font-size:22px;font-weight:700}.ver{font-size:11px;font-weight:400;color:#8a93a3}
    select{font-size:18px;font-weight:700;border:1px solid #ccd;border-radius:6px;padding:2px 6px}
    button{cursor:pointer;font-size:14px;border:1px solid #ccd;background:#fff;border-radius:6px;padding:6px 12px;margin-left:6px}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0 6px}
    .stat{background:#fff;border-radius:10px;padding:14px;border-top:5px solid #aab}
    .stat span{display:block;font-size:28px;font-weight:800}
    .stat small{color:#5a6577}
    .a{border-color:#2e9d5b}.b{border-color:#2f7fc1}.c{border-color:#e0a019}.f{border-color:#d64545}.na{border-color:#aab}
    .ta{color:#2e9d5b}.tb{color:#2f7fc1}.tc{color:#b07a00}.tf{color:#d64545;font-weight:700}
    .sub{color:#5a6577;font-size:13px;margin-bottom:10px}.err{color:#d64545}
    .tabs button{margin:0 6px 12px 0}.tabs .on{background:#1f3a5f;color:#fff;border-color:#1f3a5f}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:10px;align-items:start}
    .card.open{grid-column:1/-1}
    .card{background:#fff;border-radius:8px;padding:9px 12px;border-left:5px solid #aab}
    .row1{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
    .cname{font-size:15px;font-weight:700;line-height:1.2}.teacher{color:#5a6577;font-size:12px}
    .big{font-size:22px;font-weight:800;text-align:right;line-height:1.1;white-space:nowrap}.big small{display:block;font-size:12px;color:#5a6577;font-weight:600}
    .bar{position:relative;height:7px;background:#e6e9ef;border-radius:4px;margin:7px 0}
    .fill{height:100%;border-radius:5px;background:currentColor}
    .card.a .fill{background:#2e9d5b}.card.b .fill{background:#2f7fc1}.card.c .fill{background:#e0a019}.card.f .fill{background:#d64545}
    .tgt{position:absolute;top:-4px;width:3px;height:15px;background:#1c2430}
    .meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12.5px;align-items:center}
    .meta input{width:48px;padding:1px 3px;font-size:12.5px;border:1px solid #ccd;border-radius:4px}
    .redt{color:#d64545}
    .card.d0{border-left-color:#ec835a}.card.d1{border-left-color:#fab219}
    .pill{font-size:11.5px;padding:1px 7px;border-radius:9px;color:#0b0b0b}.pill.d0{background:#ec835a}.pill.d1{background:#fab219}
    .day{margin-bottom:10px}.day table{table-layout:fixed}.day td,.day th{overflow-wrap:anywhere;vertical-align:top}.day input,.sub input{width:56px;padding:1px 3px;font-size:12.5px;border:1px solid #ccd;border-radius:4px}
    h3{font-size:15px;margin:14px 0 4px}
    .bd{max-width:760px}.bd-head{margin:6px 0;font-size:14px}
    .bd-legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:#52514e;margin-bottom:4px}
    .ln{display:inline-block;width:16px;height:2px;vertical-align:middle;margin-right:6px}
    .c1{background:#2a78d6}.c2{background:#eb6834}.c3{background:#898781}
    .bd-plot{position:relative}.bd-plot svg{width:100%;height:auto;display:block;outline-offset:2px}
    .bd-tip{position:absolute;top:8px;width:185px;pointer-events:none;background:#fff;border:1px solid rgba(11,11,11,.1);border-radius:6px;padding:6px 8px;font-size:12px;color:#52514e;box-shadow:0 2px 8px rgba(0,0,0,.12)}
    .bd-tip[hidden]{display:none}.bd-tip .t{display:block;color:#0b0b0b;margin-bottom:3px}
    .bd-tip .row{display:flex;align-items:center;gap:6px}.bd-tip .row b{color:#0b0b0b;min-width:42px}
    .bd-tip i{display:inline-block;width:10px;height:2px}
    .bd details{font-size:12.5px;margin-top:6px}
    .advice{margin-top:6px;font-size:12.5px;background:#f4f6f9;padding:5px 8px;border-radius:5px}
    .link{border:0;background:none;color:#2f7fc1;padding:4px 0 0;margin:0;font-size:12.5px}
    table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px;background:#fff}
    th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eceff3}th{color:#5a6577;font-weight:600}
    a{color:#2f7fc1;text-decoration:none}
    .missrow{background:#fdeeee}
    tr.cm td{background:#fafbfc;color:#334;font-size:13px;padding-left:20px}
    .chip{font-size:12px;padding:2px 8px;border-radius:10px;background:#e6e9ef;white-space:nowrap}
    .chip.bad{background:#d64545;color:#fff}.chip.warn{background:#f6d58a}.chip.ok{background:#d6f0df}
    .comment{background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:10px}
    .ctext{margin:6px 0;font-size:15px;white-space:pre-wrap}.cwho{color:#5a6577;font-size:13px}
    .good{font-size:18px}
    @media print{.noprint,.fab{display:none!important}.ov{position:static;overflow:visible;background:#fff}.card,.stat{break-inside:avoid}}
  `;

  const host = document.createElement('div');
  host.id = 'crc-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><button class="fab noprint">📊 Report card v${VERSION}</button><div class="ov" hidden></div>`;
  const pstyle = document.createElement('style');
  pstyle.textContent = '@media print{body>*:not(#crc-host){display:none!important}}';
  document.head.appendChild(pstyle);

  const ov = root.querySelector('.ov');
  root.querySelector('.fab').addEventListener('click', () => {
    ov.hidden = false; render();
    if (!S.data && !S.loading) load();
  });

  ov.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') ov.hidden = true;
    else if (act === 'refresh') load();
    else if (act === 'print') window.print();
    else if (act === 'tab') { S.tab = b.dataset.tab; render(); }
    else if (act === 'toggle') {
      const cid = +b.dataset.cid;
      S.open.has(cid) ? S.open.delete(cid) : S.open.add(cid);
      render();
    }
  });
  ov.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.act === 'target') { setTarget(el.dataset.cid, el.value); render(); }
    else if (el.dataset.act === 'student') {
      S.sid = +el.value; try { localStorage.setItem(LS + 'sid', el.value); } catch {}
      S.data = null; S.open.clear(); load();
    }
  });

  // burndown hover (crosshair snaps to the nearest day) and keyboard (arrow keys)
  ov.addEventListener('pointermove', e => {
    const bd = e.target.closest('.bd');
    ov.querySelectorAll('.bd').forEach(b => { if (b !== bd) bdHide(b); });
    if (!bd) return;
    const pts = JSON.parse(bd.dataset.pts), r = bd.querySelector('svg').getBoundingClientRect();
    const x = (e.clientX - r.left) * (720 / r.width);
    let k = 0;
    pts.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(pts[k].x - x)) k = i; });
    bdShow(bd, k);
  });
  ov.addEventListener('pointerleave', () => ov.querySelectorAll('.bd').forEach(bdHide));
  ov.addEventListener('keydown', e => {
    const bd = e.target.closest && e.target.closest('.bd');
    if (!bd || !/^Arrow(Left|Right)$/.test(e.key)) return;
    e.preventDefault();
    bdShow(bd, (+bd.dataset.k || 0) + (e.key === 'ArrowRight' ? 1 : -1));
  });

  setInterval(() => { if (!ov.hidden && !S.loading) load(); }, REFRESH_MS);
  console.log('[crc] button mounted');
})();
