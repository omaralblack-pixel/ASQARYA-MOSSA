declare namespace Cloudflare {
  interface Env {
    INSTITUTION_PASSWORD?: string;
    INSTITUTION_SESSION_SECRET?: string;
    INSTITUTION_LOGIN_LIMIT?: RateLimit;
    SUPABASE_URL?: string;
    SUPABASE_STORAGE_SECRET?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
