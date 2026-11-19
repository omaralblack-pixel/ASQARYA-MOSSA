import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

import { handleInstitution } from "./institution";
import {replaceSapSnapshot} from './sap-snapshot';
import {projectSyncScope,shouldPublishProjectChange} from "../app/lib/project-sync-core";

const changeSchema='CREATE TABLE IF NOT EXISTS institution_sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL)';
let changeSchemaReady:Promise<unknown>|undefined;
/** Runs only after a successful authenticated API write. The original request
 * response is never replaced if an optional notification write fails. */
async function publishChange(request:Request,response:Response,env:Cloudflare.Env){
 const path=new URL(request.url).pathname;
 const scope=projectSyncScope(path);
 if(!scope||!env.DB||!shouldPublishProjectChange(request.method,path,response.status))return;
 if(path==='/api/lieutenant-files'&&response.headers.get('content-type')?.includes('json')){
  // Identical SHA-256 originals do not represent new SAP information.
  const result=await response.clone().json().catch(()=>null) as {duplicate?:boolean}|null;
  if(result?.duplicate)return;
 }
 try{
  await (changeSchemaReady??=env.DB.prepare(changeSchema).run().catch(error=>{changeSchemaReady=undefined;throw error}));
  await env.DB.prepare(
   'INSERT INTO institution_sync_events(scope,method,path,created_at) VALUES (?,?,?,?)'
  ).bind(scope,request.method,path,new Date().toISOString()).run();
 }catch(error){
  // Do not convert a committed invoice/SAP upload into a false save failure.
  console.error('Project sync event failed after successful write',path,error);
 }
}


const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    let response: Response | undefined;
    try {
      response = await handleInstitution(request, env);
      if(!response&&new URL(request.url).pathname==='/api/sap-snapshot')
        response=await replaceSapSnapshot(request,env);
    } catch (error) {
      console.error("Institution gateway failed before application routing", error);
      if (!new URL(request.url).pathname.startsWith("/api/")) throw error;
      return Response.json({
        error: "تعذّر تشغيل بوابة إدارة المؤسسة (HTTP 503). تحقق من أسرار الجلسة واتصال Cloudflare D1 في سجلات Worker. الملفات المحفوظة على Supabase لم تتغير.",
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (response) {await publishChange(request,response,env);return response;}
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    // Keep API errors machine-readable even when the framework returns an
    // upstream HTML 503 page. This does not claim that the database succeeded.
    const isReconciliationApi = new URL(request.url).pathname === "/api/reconcile";
    try {
      const downstream = await runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
      await publishChange(request,downstream,env);
      if (isReconciliationApi && downstream.status === 503 &&
        !(downstream.headers.get("content-type") || "").includes("application/json")) {
        return Response.json({
          error: "خدمة المطابقة غير متاحة حاليًا (HTTP 503). أرشيف الملفات محفوظ بشكل مستقل؛ تحقق من تشغيل Cloudflare Worker وربط قاعدة البيانات DB، ثم أعد المحاولة.",
        }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      return downstream;
    } catch (error) {
      if (!isReconciliationApi) throw error;
      console.error("Reconciliation API runtime failure", error);
      return Response.json({
        error: "تعطلت خدمة المطابقة قبل إكمال الطلب. تحقق من سجلات Cloudflare Worker وربط DB؛ لا تعِد رفع ملف SAP المحفوظ.",
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  },
};

export default worker;
