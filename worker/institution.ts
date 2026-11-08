import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { maxSapFileBytes, type SavedSapImport } from "../app/lib/saved-sap-import";

const sessionCookie = "__Host-institution";
const sessionSeconds = 8 * 60 * 60;
const maxRequestBytes = 2 * maxSapFileBytes;
const storagePath = "/storage/v1/object";
const bucket = "institution-sap";
const object = "current.json";
const privateHeaders = { "Cache-Control": "no-store" };

function reply(status: number, error: string) {
  return Response.json({ error }, { status, headers: privateHeaders });
}

function sessionSignature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function equals(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hasSession(request: Request, secret: string) {
  const value = request.headers.get("Cookie")?.match(/(?:^|;\s*)__Host-institution=([^;]+)/)?.[1];
  if (!value || !/^\d+\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value)) return false;
  const [expires, nonce, signature] = value.split(".");
  return Number(expires) > Date.now() && equals(signature, sessionSignature(`${expires}.${nonce}`, secret));
}

function redirect(request: Request, path: string, cookie?: string) {
  const headers = new Headers({ ...privateHeaders, Location: new URL(path, request.url).href });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function loginPage(error = "", status = 200) {
  return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>إدارة المؤسسة</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f2f6f8;color:#163449;font:16px system-ui}
main{width:min(86vw,24rem);box-sizing:border-box;padding:2rem;border:1px solid #d7e2e9;border-radius:1rem;background:white}
h1{margin:0 0 .4rem}p{margin:0 0 1.5rem;color:#496779}label{display:block;font-weight:600}
input,button{box-sizing:border-box;width:100%;padding:.8rem;margin-top:.6rem;border:1px solid #b7cbd7;border-radius:.45rem;font:inherit}
button{background:#196f82;color:white;cursor:pointer}.error{color:#a32929;margin-top:1rem;margin-bottom:0}</style>
<main><h1>إدارة المؤسسة</h1><p>مركز الكيلاني للأغذية</p><form method="post" action="/login">
<label for="password">كلمة السر</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required>
<button>تسجيل الدخول</button></form>${error ? `<p class="error" role="alert">${error}</p>` : ""}</main></html>`,
  { status, headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
}

async function readBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new RangeError();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
}

async function savedImport(request: Request, env: Cloudflare.Env) {
  const { SUPABASE_URL, SUPABASE_STORAGE_SECRET } = env;
  if (!SUPABASE_URL || !SUPABASE_STORAGE_SECRET) return reply(503, "حفظ كشف SAP على Supabase غير مفعّل.");
  const method = request.method;
  if (!["GET", "PUT", "DELETE"].includes(method)) return reply(405, "طريقة الطلب غير مدعومة.");
  const headers = new Headers({ apikey: SUPABASE_STORAGE_SECRET });
  const base = new URL(storagePath, SUPABASE_URL).href;
  let url = `${base}/${bucket}/${object}`;
  let body: string | undefined;
  if (method === "GET") {
    url = `${base}/authenticated/${bucket}/${object}`;
  } else if (method === "PUT") {
    try {
      body = await readBody(request, maxRequestBytes);
      const file = JSON.parse(body) as SavedSapImport;
      if (typeof file?.name !== "string" || file.name.length > 255 || !/\.txt$/i.test(file.name) ||
          typeof file.text !== "string" || !file.text.trim() || new Blob([file.text]).size > maxSapFileBytes) {
        return reply(400, "اختار كشف SAP نصي صالح بحجم لا يتجاوز 16 ميغابايت.");
      }
    } catch (error) {
      return error instanceof RangeError ? reply(413, "حجم كشف SAP كبير.") : reply(400, "تعذّر قراءة نص الكشف.");
    }
    headers.set("Content-Type", "application/json");
    headers.set("x-upsert", "true");
  } else {
    url = `${base}/${bucket}`;
    headers.set("Content-Type", "application/json");
    body = JSON.stringify({ prefixes: [object] });
  }
  try {
    const result = await fetch(url, { method: method === "PUT" ? "POST" : method, headers, body });
    if (method === "GET" && result.status === 404) return Response.json(null, { headers: privateHeaders });
    if (!result.ok) return reply(502, "تعذّر الوصول إلى كشف SAP على Supabase.");
    if (method === "GET") {
      return new Response(result.body, { headers: { ...privateHeaders, "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 204, headers: privateHeaders });
  } catch {
    return reply(502, "تعذّر الاتصال بـ Supabase.");
  }
}

export async function handleInstitution(request: Request, env: Cloudflare.Env): Promise<Response | undefined> {
  const url = new URL(request.url);
  const api = url.pathname.startsWith("/api/");
  const secret = env.INSTITUTION_SESSION_SECRET;
  const password = env.INSTITUTION_PASSWORD;
  if (!secret || secret.length < 32 || !password || !env.INSTITUTION_LOGIN_LIMIT) {
    return api ? reply(503, "تسجيل الدخول غير مفعّل.") : loginPage("إعداد تسجيل الدخول غير مكتمل.", 503);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("Origin") !== url.origin) {
    return reply(403, "الطلب لازم يكون من نفس الموقع.");
  }
  const authenticated = hasSession(request, secret);
  const cookieAttributes = "Path=/; Secure; HttpOnly; SameSite=Lax";
  if (url.pathname === "/login") {
    if (authenticated) return redirect(request, "/reconciliation");
    if (request.method === "GET") return loginPage();
    if (request.method !== "POST") return reply(405, "طريقة الطلب غير مدعومة.");
    const { success } = await env.INSTITUTION_LOGIN_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return loginPage("محاولات كثيرة. جرّب بعد دقيقة.", 429);
    let entered: string | null;
    try {
      entered = new URLSearchParams(await readBody(request, 2048)).get("password");
    } catch {
      return loginPage("تعذّر قراءة كلمة السر.", 400);
    }
    if (!entered || !equals(sessionSignature(entered, secret), sessionSignature(password, secret))) {
      return loginPage("كلمة السر غير صحيحة.", 401);
    }
    const value = `${Date.now() + sessionSeconds * 1000}.${randomBytes(16).toString("hex")}`;
    return redirect(request, "/reconciliation", `${sessionCookie}=${value}.${sessionSignature(value, secret)}; ${cookieAttributes}; Max-Age=${sessionSeconds}`);
  }
  if (!authenticated) return api ? reply(401, "سجّل الدخول أولاً.") : redirect(request, "/login");
  if (url.pathname === "/logout" && request.method === "POST") {
    return redirect(request, "/login", `${sessionCookie}=; ${cookieAttributes}; Max-Age=0`);
  }
  if (url.pathname === "/api/sap-import") return savedImport(request, env);
}
