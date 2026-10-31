// FoodVibe Manager — dashboard logic (FOODVIBE.md §15).
// Static site: the browser holds ONLY the anon key + the signed-in
// admin's own session. Every read/action goes through the guarded
// admin_* RPCs from migration_005; manual pushes go through the
// admin-push Edge Function. No service-role key here, ever.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://rpkuqyxeyelvsylrytvk.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwa3VxeXhleWVsdnN5bHJ5dHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0MTcwODAsImV4cCI6MjEwODk5MzA4MH0.vcC10g72S1LLjO3qZh_sYEI4Ju6X-iXjYUS8B0b5EMQ';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const fmtDate = (ts) => ts
  ? new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
  : '—';
const fmtDay = (d) => new Date(`${d}T00:00:00`)
  .toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

function looksLikeMissingMigration(err) {
  const m = `${err?.code ?? ''} ${err?.message ?? ''}`;
  return m.includes('PGRST202') || m.includes('does not exist');
}

// ------------------------------------------------------------- state
let appStarted = false;
let sellersCache = [];
let map = null;
let mapLayer = null;

// ------------------------------------------------------------- auth UI
function showOnly(id) {
  for (const s of ['#view-auth', '#view-denied', '#view-app']) {
    $(s).classList.toggle('hidden', s !== id);
  }
}

$('#btn-google').addEventListener('click', async () => {
  const msg = $('#auth-msg');
  setMsg(msg, 'Opening Google sign-in…');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) setMsg(msg, error.message, 'error');
});

$('#form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#auth-msg');
  const email = $('#input-email').value.trim();
  const btn = $('#btn-send-code');
  btn.disabled = true;
  setMsg(msg, 'Sending code…');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  btn.disabled = false;
  if (error) { setMsg(msg, error.message, 'error'); return; }
  setMsg(msg, `Code sent to ${email}. Check your inbox.`, 'ok');
  $('#form-email').classList.add('hidden');
  $('#form-code').classList.remove('hidden');
  $('#input-code').focus();
});

$('#form-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#auth-msg');
  const email = $('#input-email').value.trim();
  const token = $('#input-code').value.trim();
  setMsg(msg, 'Verifying…');
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) { setMsg(msg, error.message, 'error'); return; }
  setMsg(msg, 'Signed in.', 'ok');
  // onAuthStateChange takes it from here.
});

$('#btn-back-email').addEventListener('click', () => {
  $('#form-code').classList.add('hidden');
  $('#form-email').classList.remove('hidden');
  setMsg($('#auth-msg'), '');
});

async function signOut() {
  await supabase.auth.signOut();
  window.location.reload();
}
$('#btn-logout').addEventListener('click', signOut);
$('#btn-denied-logout').addEventListener('click', signOut);

// ------------------------------------------------------------- entry
async function enterWithSession(session) {
  if (appStarted) return;
  const email = session.user.email ?? '';
  let isAdmin = false;
  try {
    isAdmin = await rpc('is_admin');
  } catch (err) {
    if (looksLikeMissingMigration(err)) {
      $('#denied-email').textContent = email;
      document.querySelector('#view-denied .muted').textContent =
        'The dashboard database setup (migration 005) has not been applied to the FoodVibe project yet, so admin access cannot be checked. Please check back once it is live.';
      showOnly('#view-denied');
      return;
    }
    setMsg($('#auth-msg'), `Could not check admin access: ${err.message}`, 'error');
    return;
  }
  if (!isAdmin) {
    $('#denied-email').textContent = email;
    showOnly('#view-denied');
    return;
  }
  appStarted = true;
  $('#who').textContent = email;
  showOnly('#view-app');
  await refreshAll();
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) enterWithSession(session);
});
supabase.auth.getSession().then(({ data }) => {
  if (data.session) enterWithSession(data.session);
  else showOnly('#view-auth');
});

// ------------------------------------------------------------- views
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  const view = btn.dataset.view;
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t === btn));
  document.querySelectorAll('.panel').forEach((p) =>
    p.classList.toggle('hidden', p.id !== `panel-${view}`));
  if (view === 'map') initMap();
});

$('#btn-refresh').addEventListener('click', refreshAll);

async function refreshAll() {
  if (!appStarted) return;
  const msg = $('#app-msg');
  setMsg(msg, 'Loading…');
  try {
    await Promise.all([
      loadOverview(), loadChart(), loadUsers(),
      loadSellers(), loadReports(), loadAdmins(),
    ]);
    setMsg(msg, '');
    if (map) refreshMap();
  } catch (err) {
    setMsg(msg, looksLikeMissingMigration(err)
      ? 'The dashboard database setup (migration 005) has not been applied yet.'
      : `Load failed: ${err.message}`, 'error');
  }
}

// ------------------------------------------------------------- overview
async function loadOverview() {
  const o = await rpc('admin_overview');
  const cards = [
    ['Total users', o.total_users],
    ['Signups today', o.signups_today],
    ['Signups · 7 days', o.signups_7d],
    ['Sellers live now', o.sellers_live_now],
    ['Total sellers', o.total_sellers],
    ['Total purchases', o.total_purchases],
    ['Avg rating', o.avg_rating == null ? '—' : `⭐ ${Number(o.avg_rating).toFixed(2)}`],
    ['Open reports', o.open_reports],
  ];
  $('#stat-cards').innerHTML = cards.map(([lbl, num]) =>
    `<div class="stat"><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div></div>`
  ).join('');
}

async function loadChart() {
  const rows = await rpc('admin_signups_by_day', { p_days: 30 });
  const canvas = $('#chart-signups');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 900;
  const height = 160;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const max = Math.max(1, ...rows.map((r) => Number(r.signups)));
  const padB = 20, padT = 16;
  const barW = width / rows.length;
  ctx.clearRect(0, 0, width, height);
  rows.forEach((r, i) => {
    const v = Number(r.signups);
    const h = ((height - padB - padT) * v) / max;
    ctx.fillStyle = '#e65100';
    ctx.beginPath();
    ctx.roundRect(i * barW + 2, height - padB - h, Math.max(2, barW - 4), h, 3);
    ctx.fill();
    if (v > 0) {
      ctx.fillStyle = '#3E2723';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(v), i * barW + barW / 2, height - padB - h - 4);
    }
    if (i % 5 === 0 || i === rows.length - 1) {
      ctx.fillStyle = '#8d6e63';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(fmtDay(r.day), i * barW + barW / 2, height - 6);
    }
  });
}

// ------------------------------------------------------------- users
async function loadUsers() {
  const rows = await rpc('admin_users');
  $('#table-users').innerHTML = `
    <tr><th>Name</th><th>Email</th><th>Role</th><th>Seller</th><th>Admin</th>
        <th>Food alerts</th><th>Joined</th></tr>
    ${rows.map((u) => `<tr>
      <td>${esc(u.display_name || '—')}</td>
      <td>${esc(u.email)}</td>
      <td>${esc(u.role)}</td>
      <td>${u.is_seller ? 'Yes' : '—'}</td>
      <td>${u.is_admin ? '<span class="pill root">Admin</span>' : '—'}</td>
      <td>${u.push_alerts ? 'On' : 'Off'}</td>
      <td>${fmtDate(u.created_at)}</td></tr>`).join('')}`;
}

// ------------------------------------------------------------- sellers
async function loadSellers() {
  sellersCache = await rpc('admin_sellers');
  $('#table-sellers').innerHTML = `
    <tr><th>Seller</th><th>Type</th><th>Category</th><th>Rating</th>
        <th>Live</th><th>Status</th><th></th></tr>
    ${sellersCache.map((s) => `<tr>
      <td><strong>${esc(s.display_name || '—')}</strong><br>
          <span class="muted">${esc(s.speciality || '')}</span><br>
          <span class="muted">${esc(s.email || '')}</span></td>
      <td>${esc(s.seller_type)}</td>
      <td>${esc(s.category || '—')}</td>
      <td>${Number(s.rating_count) > 0 ? `⭐ ${Number(s.rating_avg).toFixed(1)} (${s.rating_count})` : '—'}</td>
      <td>${s.is_live ? '<span class="pill live">Live now</span>' : '—'}</td>
      <td>${s.suspended ? '<span class="pill susp">Suspended</span>' : 'Active'}</td>
      <td>${s.suspended
        ? `<button class="btn btn-sm" data-reinstate="${esc(s.id)}">Reinstate</button>`
        : `<button class="btn btn-sm btn-danger" data-suspend="${esc(s.id)}">Suspend</button>`}</td>
    </tr>`).join('')}`;
  // Push composer seller picker shares this cache.
  $('#push-seller').innerHTML = sellersCache.map((s) =>
    `<option value="${esc(s.id)}">${esc(s.display_name || s.email || s.id)}${s.suspended ? ' (suspended)' : ''}</option>`
  ).join('');
}

$('#table-sellers').addEventListener('click', async (e) => {
  const sus = e.target.closest('[data-suspend]');
  const rei = e.target.closest('[data-reinstate]');
  if (!sus && !rei) return;
  const btn = sus || rei;
  btn.disabled = true;
  try {
    const res = await rpc('admin_suspend_seller', {
      p_seller_id: btn.dataset.suspend || btn.dataset.reinstate,
      p_suspended: Boolean(sus),
    });
    if (!res.ok) throw new Error(res.error || 'action failed');
    await Promise.all([loadSellers(), loadOverview()]);
    if (map) refreshMap();
  } catch (err) {
    setMsg($('#app-msg'), `Seller update failed: ${err.message}`, 'error');
    btn.disabled = false;
  }
});

// ------------------------------------------------------------- reports
async function loadReports() {
  const rows = await rpc('admin_reports');
  const open = rows.filter((r) => r.status === 'open').length;
  const badge = $('#reports-badge');
  badge.textContent = open;
  badge.classList.toggle('hidden', open === 0);
  $('#reports-list').innerHTML = rows.length === 0
    ? '<p class="muted">No reports yet.</p>'
    : rows.map((r) => `
    <article class="report ${r.status !== 'open' ? 'handled' : ''}">
      <div class="r-head">
        <strong>${esc(r.reason || 'Report')}</strong>
        <span class="pill ${r.status === 'open' ? 'susp' : ''}">${esc(r.status)}</span>
      </div>
      ${r.note ? `<div>${esc(r.note)}</div>` : ''}
      <div class="muted">Seller: <strong>${esc(r.seller_name || '—')}</strong>
        ${r.seller_suspended ? '<span class="pill susp">suspended</span>' : ''}
        · Reported by ${esc(r.reporter_name || '—')} (${esc(r.reporter_email || '—')})
        · ${fmtDate(r.created_at)}</div>
      <div class="r-actions">
        ${r.status === 'open' ? `
          <button class="btn btn-sm" data-dismiss="${esc(r.id)}">Dismiss</button>
          ${r.seller_id && !r.seller_suspended
            ? `<button class="btn btn-sm btn-danger" data-suspend-for="${esc(r.id)}" data-seller="${esc(r.seller_id)}">Suspend seller</button>`
            : ''}` : ''}
        ${r.seller_id && r.seller_suspended
          ? `<button class="btn btn-sm" data-reinstate-seller="${esc(r.seller_id)}">Reinstate seller</button>` : ''}
      </div>
    </article>`).join('');
}

$('#reports-list').addEventListener('click', async (e) => {
  const dismiss = e.target.closest('[data-dismiss]');
  const suspendFor = e.target.closest('[data-suspend-for]');
  const reinstate = e.target.closest('[data-reinstate-seller]');
  if (!dismiss && !suspendFor && !reinstate) return;
  const btn = dismiss || suspendFor || reinstate;
  btn.disabled = true;
  try {
    if (dismiss) {
      const res = await rpc('admin_set_report', {
        p_report_id: dismiss.dataset.dismiss, p_status: 'dismissed',
      });
      if (!res.ok) throw new Error(res.error || 'dismiss failed');
    } else if (suspendFor) {
      const res = await rpc('admin_suspend_seller', {
        p_seller_id: suspendFor.dataset.seller, p_suspended: true,
      });
      if (!res.ok) throw new Error(res.error || 'suspend failed');
      await rpc('admin_set_report', {
        p_report_id: suspendFor.dataset.suspendFor, p_status: 'actioned',
      });
    } else {
      const res = await rpc('admin_suspend_seller', {
        p_seller_id: reinstate.dataset.reinstateSeller, p_suspended: false,
      });
      if (!res.ok) throw new Error(res.error || 'reinstate failed');
    }
    await Promise.all([loadReports(), loadSellers(), loadOverview()]);
    if (map) refreshMap();
  } catch (err) {
    setMsg($('#app-msg'), `Report action failed: ${err.message}`, 'error');
    btn.disabled = false;
  }
});

// ------------------------------------------------------------- map
function initMap() {
  if (map) { refreshMap(); return; }
  map = L.map('map').setView([12.9716, 77.5946], 11); // Bengaluru
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
  refreshMap();
}

async function refreshMap() {
  if (!map || !mapLayer) return;
  mapLayer.clearLayers();
  const live = sellersCache.filter((s) => s.is_live && s.latitude != null);
  for (const s of live) {
    L.circleMarker([s.latitude, s.longitude], {
      radius: 8, color: '#fff', weight: 2, fillColor: '#e65100', fillOpacity: 1,
    }).bindPopup(
      `<strong>${esc(s.display_name || 'Seller')}</strong><br>` +
      `${esc(s.speciality || '')}<br>${esc(s.seller_type)}` +
      `${Number(s.rating_count) > 0 ? `<br>⭐ ${Number(s.rating_avg).toFixed(1)} (${s.rating_count})` : ''}`,
    ).addTo(mapLayer);
  }
  try {
    const cells = await rpc('admin_area_density');
    for (const c of cells) {
      L.circle([c.cell_lat, c.cell_lng], {
        radius: 400 + Number(c.user_count) * 150,
        color: '#e65100', weight: 1,
        fillColor: '#ffb300',
        fillOpacity: Math.min(0.12 + Number(c.user_count) * 0.04, 0.5),
      }).bindPopup(`${c.user_count} opted-in user(s) in this area`).addTo(mapLayer);
    }
  } catch { /* density is best-effort; pins still show */ }
  $('#map-empty').textContent = live.length === 0
    ? 'No sellers are live right now. Pins appear here the moment a seller turns on “I’m selling now”.'
    : '';
}

$('#btn-map-fit').addEventListener('click', () => {
  if (!map) return;
  const live = sellersCache.filter((s) => s.is_live && s.latitude != null);
  if (live.length > 0) {
    map.fitBounds(live.map((s) => [s.latitude, s.longitude]), { padding: [40, 40] });
  }
});

// ------------------------------------------------------------- push
document.querySelectorAll('input[name="audience"]').forEach((r) => {
  r.addEventListener('change', () => {
    const v = document.querySelector('input[name="audience"]:checked').value;
    $('#area-fields').classList.toggle('hidden', v !== 'area');
    $('#seller-field').classList.toggle('hidden', v !== 'seller');
  });
});

$('#btn-use-map-centre').addEventListener('click', () => {
  if (!map) { initMap(); }
  const c = map.getCenter();
  $('#push-lat').value = c.lat.toFixed(5);
  $('#push-lng').value = c.lng.toFixed(5);
});

$('#form-push').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = $('#push-result');
  const btn = $('#btn-send-push');
  const audience = document.querySelector('input[name="audience"]:checked').value;
  const payload = {
    audience,
    title: $('#push-title').value.trim(),
    body: $('#push-body').value.trim(),
  };
  if (!payload.title || !payload.body) {
    setMsg(result, 'Title and message are required.', 'error');
    return;
  }
  if (audience === 'area') {
    payload.lat = Number($('#push-lat').value);
    payload.lng = Number($('#push-lng').value);
    payload.radiusKm = Number($('#push-radius').value);
    if (!isFinite(payload.lat) || !isFinite(payload.lng) || !(payload.radiusKm > 0)) {
      setMsg(result, 'Area needs a latitude, longitude and radius.', 'error');
      return;
    }
  }
  if (audience === 'seller') {
    payload.sellerId = $('#push-seller').value;
    if (!payload.sellerId) { setMsg(result, 'Pick a seller first.', 'error'); return; }
  }
  btn.disabled = true;
  setMsg(result, 'Sending…');
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('session expired — sign in again');
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-push`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `send failed (${res.status})`);
    setMsg(result,
      `Sent to ${out.sent} device(s) — matched ${out.matched}, failed ${out.failed}.`,
      'ok');
  } catch (err) {
    setMsg(result, `Push failed: ${err.message}. ` +
      '(If this is a 404, the admin-push function has not been deployed yet.)', 'error');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------- admins
async function loadAdmins() {
  const rows = await rpc('admin_list_admins');
  $('#table-admins').innerHTML = `
    <tr><th>Email</th><th>Added by</th><th>Since</th><th></th></tr>
    ${rows.map((a) => `<tr>
      <td>${esc(a.email)} ${a.is_root ? '<span class="pill root">Root</span>' : ''}</td>
      <td>${esc(a.added_by || '—')}</td>
      <td>${fmtDate(a.created_at)}</td>
      <td>${a.is_root
        ? '<span class="muted">cannot be removed</span>'
        : `<button class="btn btn-sm btn-danger" data-remove-admin="${esc(a.email)}">Remove</button>`}</td>
    </tr>`).join('')}`;
}

$('#form-add-admin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#admins-msg');
  const email = $('#input-new-admin').value.trim();
  try {
    const res = await rpc('admin_add_admin', { p_email: email });
    if (!res.ok) throw new Error(res.error || 'could not add admin');
    $('#input-new-admin').value = '';
    setMsg(msg, `${res.email} is now an admin.`, 'ok');
    await loadAdmins();
  } catch (err) {
    setMsg(msg, err.message, 'error');
  }
});

$('#table-admins').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove-admin]');
  if (!btn) return;
  const email = btn.dataset.removeAdmin;
  if (!window.confirm(`Remove ${email} from admins? They lose dashboard access immediately.`)) return;
  btn.disabled = true;
  try {
    const res = await rpc('admin_remove_admin', { p_email: email });
    if (!res.ok) throw new Error(res.error || 'could not remove admin');
    setMsg($('#admins-msg'), `${res.email} removed.`, 'ok');
    await loadAdmins();
  } catch (err) {
    setMsg($('#admins-msg'), err.message, 'error');
    btn.disabled = false;
  }
});
