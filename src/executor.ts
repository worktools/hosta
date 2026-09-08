import { executeWithHoya, artifactHash } from '../lib/hoya-client.mjs';
import { validateJsonSchema } from './validator.js';
import { store, save } from './store.js';
import { datasourceByAppId, id, now } from './utils.js';
import type { Version, Run, ExecuteOptions } from './types.js';

/** Compatibility queries cannot re-enable the old in-process executor. */
export function getHoyaEnabled(): boolean { return true; }
export function setHoyaEnabled(enabled: boolean): void {
  if (!enabled) throw new Error('Node execution fallback is unavailable; configure the independent Hoya engine');
}
export async function execute(version:Version,input:Record<string,unknown>,trigger:string,options:ExecuteOptions={}):Promise<Run> {
  const ds=datasourceByAppId(version.appId);
  const snapshot=ds?store.datasourceSnapshots.filter(s=>s.appId===version.appId&&s.status==='applied').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]:undefined;
  const run:Run={id:id('run'),retryOf:options.retryOf||null,appId:version.appId,versionId:version.id,versionNumber:version.number,datasourceSnapshotId:snapshot?.id||null,trigger,status:'running',input,logs:[],createdAt:now(),startedAt:now(),parentRunId:options.parentRunId||null,callerAppId:options.callerAppId||null,callDepth:options.callDepth||0};
  store.runs.push(run);await save();const start=performance.now();
  try {
    if(version.inputSchema?.type) {
      const errors=validateJsonSchema(version.inputSchema,input);
      if(errors.length) {run.status='rejected';run.error={code:'SCHEMA_VALIDATION_FAILED',message:errors.join('; '),schemaErrors:errors};return run;}
    }
    const response=await executeWithHoya(version,input,run.id,ds?.data||{});
    Object.assign(run,response,{logs:response.logs.map(log=>({...log,at:new Date(log.at).toISOString()}))});
  } catch(e) {
    const error=e as Error & {code?:string;retryable?:boolean};
    run.status='internal_error';run.error={code:error.code||'PLATFORM_ERROR',message:error.message,retryable:Boolean(error.retryable)};
  } finally {run.finishedAt=now();run.durationMs=Math.round(performance.now()-start);await save();}
  return run;
}

/** Existing migration scripts are also executed outside the control process. */
export async function runMigration(app:{id:string},migrationScript:string):Promise<{success:boolean;before:Record<string,unknown>;after:Record<string,unknown>;logs:string[];error?:string}> {
  const before=datasourceByAppId(app.id)?.data||{};
  const code=`function main(input, ctx) { let data = input; const console = { log(...args) { ctx.log("info", args.map(value => typeof value === "object" ? JSON.stringify(value) : String(value)).join(" ")); } }; ${migrationScript}\n; return data; }`;
  try {
    const response=await executeWithHoya({code,runtime:'javascript',codeSha256:artifactHash(code,'javascript')},before,id('migration'));
    const after=response.result;
    if(response.status!=='succeeded'||!after||typeof after!=='object'||Array.isArray(after))throw new Error(response.error?.message||'Migration must produce an object');
    return {success:true,before,after:after as Record<string,unknown>,logs:response.logs.map(log=>log.message)};
  } catch(e) {return {success:false,before,after:before,logs:[],error:(e as Error).message};}
}
