// FoodVibe admin-push Edge Function (Manager dashboard, FOODVIBE.md §15)
// =====================================================================
// Lets a signed-in dashboard admin send a manual push notification:
//
//   POST { title, body, audience: "all" }
//     -> every user who OPTED IN (profiles.push_alerts) and has a token.
//   POST { title, body, audience: "area", lat, lng, radiusKm }
//     -> opted-in users whose saved alert area (profiles.notify_lat /
//        notify_lng — the ~1 km rounded area from migration 004) falls
//        within radiusKm of the given centre (haversine on the area
//        point; the dashboard's map use-case).
//   POST { title, body, audience: "seller", sellerId }
//     -> that one seller's own device (their profile's fcm_token).
//
// Auth: the CALLER's own JWT (the dashboard passes the admin's session
// token) is verified against Supabase Auth, and the caller's email must
// be in the `admins` allowlist (migration 005). The service-role key is
// used ONLY inside this function to read the allowlist + recipient
// tokens — it never reaches the browser.
//
// Sending mirrors push-notify exactly: FCM HTTP v1, OAuth minted from
// the FCM_SERVICE_ACCOUNT_JSON secret with WebCrypto, and profiles'
// fcm_token values are Firebase Installation IDs, which FCM accepts
// directly as the message token.
//
// Deploy note: deploy with the default "verify JWT" ON — callers always
// carry a real user JWT, and this function re-checks admin status
// itself. Secrets/env: FCM_SERVICE_ACCOUNT_JSON (shared with
// push-notify), SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase).
// =====================================================================

const FCM_PROJECT_FALLBACK = "foodvibe-513306";

// ------------------------------------------------------------- env/cors
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ------------------------------------------------------- FCM via OAuth
// (Copied from push-notify/index.ts — keep the two in step.)
type ServiceAccount = {
  project_id?: string;
  client_email: string;
  private_key: string;
};
let saCache: ServiceAccount | null = null;
function serviceAccount(): ServiceAccount {
  if (saCache) return saCache;
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("FCM_SERVICE_ACCOUNT_JSON secret is not set");
  saCache = JSON.parse(raw) as ServiceAccount;
  return saCache;
}

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

let tokenCache: { token: string; expMs: number } | null = null;
async function googleAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expMs > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`oauth token exchange failed: ${res.status}`);
  }
  const data = await res.json();
  tokenCache = {
    token: data.access_token as string,
    expMs: Date.now() + (Number(data.expires_in ?? 3600) * 1000),
  };
  return tokenCache.token;
}

/// Send ONE notification via FCM HTTP v1. Throws on HTTP failure.
async function sendPush(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<void> {
  const access = await googleAccessToken();
  const project = serviceAccount().project_id ?? FCM_PROJECT_FALLBACK;
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${project}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
          android: { priority: "high" },
        },
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fcm send failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ------------------------------------------------- service-role access
async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/// Verify the caller's JWT against Supabase Auth; returns their email.
async function callerEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === SERVICE_ROLE_KEY) return null; // must be a USER jwt
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { "apikey": ANON_KEY, "Authorization": `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return typeof user?.email === "string" ? user.email : null;
}

/// Is this email on the admins allowlist? (service-role read)
async function emailIsAdmin(email: string): Promise<boolean> {
  const res = await rest(
    `admins?select=email&email=ilike.${encodeURIComponent(email)}`,
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

// ------------------------------------------------------------ audiences
type Target = { userId: string; token: string };

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function optedInTargets(): Promise<Target[]> {
  const res = await rest(
    "profiles?select=id,fcm_token,notify_lat,notify_lng" +
      "&push_alerts=eq.true&fcm_token=not.is.null",
  );
  if (!res.ok) throw new Error("profiles query failed");
  const rows = await res.json();
  return (rows as Record<string, unknown>[]).map((r) => ({
    userId: r.id as string,
    token: r.fcm_token as string,
    lat: r.notify_lat as number | null,
    lng: r.notify_lng as number | null,
  })) as (Target & { lat: number | null; lng: number | null })[];
}

function dedupe(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    if (!t.token || seen.has(t.token)) return false;
    seen.add(t.token);
    return true;
  });
}

// ---------------------------------------------------------------- main
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // 1. Who is calling? A real signed-in user…
  const email = await callerEmail(req);
  if (!email) return json({ error: "unauthorized" }, 401);
  // 2. …who is on the admins allowlist.
  if (!(await emailIsAdmin(email))) {
    return json({ error: "not an admin" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "expected a JSON body" }, 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const audience = body.audience as string;
  if (!title || !text) {
    return json({ error: "title and body are required" }, 400);
  }
  if (!["all", "area", "seller"].includes(audience)) {
    return json({ error: "audience must be all | area | seller" }, 400);
  }

  try {
    let targets: Target[] = [];
    if (audience === "all") {
      targets = await optedInTargets();
    } else if (audience === "area") {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const radiusKm = Number(body.radiusKm);
      if (!isFinite(lat) || !isFinite(lng) || !isFinite(radiusKm) ||
        radiusKm <= 0) {
        return json({ error: "area needs lat, lng and radiusKm > 0" }, 400);
      }
      const all = await optedInTargets();
      targets = all.filter((t) =>
        t.lat != null && t.lng != null &&
        haversineKm(lat, lng, t.lat, t.lng) <= radiusKm
      );
    } else {
      // audience === "seller": the seller's profile IS their account
      // (sellers.id = profiles.id), so their token is on the profile.
      const sellerId = body.sellerId as string;
      if (!sellerId) return json({ error: "sellerId is required" }, 400);
      const res = await rest(
        `profiles?id=eq.${encodeURIComponent(sellerId)}&select=id,fcm_token`,
      );
      if (!res.ok) throw new Error("profile query failed");
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].fcm_token) {
        targets = [{ userId: rows[0].id, token: rows[0].fcm_token }];
      }
    }

    targets = dedupe(targets);
    let sent = 0;
    let failed = 0;
    for (const t of targets) {
      try {
        await sendPush(t.token, title, text, {
          type: "admin",
          audience,
        });
        sent++;
      } catch (_) {
        failed++;
      }
    }
    return json({ audience, matched: targets.length, sent, failed });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
