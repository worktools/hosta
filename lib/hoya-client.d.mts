import type { Version, Run, LogEntry } from '../src/types.js';
export const limits: {timeoutMs:number;memoryMb:number;maxLogBytes:number;maxResultBytes:number};
export function artifactHash(code:string,runtime:string):string;
export class EngineError extends Error {code:string;retryable:boolean;constructor(code:string,message:string,retryable?:boolean);}
export function engineStatus():Promise<{status:string;error?:{code:string;message:string;retryable:boolean};[key:string]:unknown}>;
export function executeWithHoya(version:Pick<Version,'code'|'runtime'|'codeSha256'>,input:unknown,runId:string,datasource?:unknown):Promise<{status:Run['status'];result:unknown;logs:Array<Omit<LogEntry,'at'> & {at:number}>;error:Run['error'];metrics:{durationMs:number};artifactSha256:string;protocolVersion:string}>;
