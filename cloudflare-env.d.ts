declare namespace Cloudflare {
  interface Env {
    INSTITUTION_PASSWORD?: string;
    INSTITUTION_SESSION_SECRET?: string;
    INSTITUTION_LOGIN_LIMIT?: RateLimit;
    SUPABASE_URL?: string;
    SUPABASE_STORAGE_SECRET?: string;
    DB?: D1Database;
    CF_VERSION_METADATA?: {id:string;tag?:string;timestamp?:string};
    BUCKET?: R2Bucket;
  }
}
