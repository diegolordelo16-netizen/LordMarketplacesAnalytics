import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error standalone ESM bridge intentionally has no TS declarations
import { handleMcp, callLocalTool, toolList } from '../../../scripts/openseo-mcp.mjs';
describe('MCP SEO local read-only',()=>{
  it('lists only read-only tools and ignores notifications',async()=>{
    expect(toolList().every((t:{annotations:{readOnlyHint:boolean}})=>t.annotations.readOnlyHint)).toBe(true);
    expect(await handleMcp({jsonrpc:'2.0',method:'notifications/initialized'})).toBeNull();
    expect(await handleMcp({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})).toMatchObject({result:{protocolVersion:'2025-06-18'}});
  });
  it('uses only loopback and allowlisted read methods',async()=>{
    const transport=vi.fn(async(url:string,init:RequestInit)=>{
      expect(url).toBe('http://127.0.0.1:12345/api/ipc');
      expect(JSON.parse(String(init.body))).toMatchObject({method:'seo.external.history',payload:{accountId:'test'}});
      return Response.json({ok:true,result:[]});
    });
    const env={MI_MCP_PORT:'12345',MI_MCP_TOKEN:'fixture'};
    await expect(callLocalTool('seo.external.research',{accountId:'test'},env,transport)).rejects.toThrow();
    await expect(callLocalTool('seo_history',{accountId:'test',confirmed:true},env,transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(await callLocalTool('seo_history',{accountId:'test'},env,transport)).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
