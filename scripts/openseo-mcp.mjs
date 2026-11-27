// Optional local stdio MCP bridge. No paid queries or mutations exposed.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const definitions={
  seo_history:{method:'seo.external.history',description:'List saved external SEO queries for one store',props:{accountId:{type:'string'},limit:{type:'integer',minimum:1,maximum:200}},required:['accountId']},
  seo_result:{method:'seo.external.get',description:'Read a saved external SEO result, no provider request',props:{accountId:{type:'string'},id:{type:'string'}},required:['accountId','id']},
  seo_gap:{method:'seo.external.gap',description:'Compare two saved ranked-domain samples in the same account',props:{accountId:{type:'string'},ownId:{type:'string'},otherId:{type:'string'}},required:['accountId','ownId','otherId']},
  seo_groups:{method:'seo.external.groups',description:'Group saved keywords and compare lexical fit to the catalog',props:{accountId:{type:'string'},id:{type:'string'}},required:['accountId','id']},
  seo_rank_history:{method:'seo.watch.history',description:'Read saved Google ranking history for a watch',props:{accountId:{type:'string'},id:{type:'string'}},required:['accountId','id']},
};
export function toolList(){return Object.entries(definitions).map(([name,d])=>({name,description:d.description,inputSchema:{type:'object',properties:d.props,required:d.required,additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}));}
export async function callLocalTool(name,args,env=process.env,transport=fetch){
  if(!Object.hasOwn(definitions,name))throw Error('Unknown or disallowed tool.');
  const d=definitions[name];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(d.props,k))||d.required.some(k=>typeof args[k]!=='string'||!args[k].trim()))throw Error('Invalid tool arguments.');
  if(args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>200))throw Error('Invalid limit.');
  const port=Number(env.MI_MCP_PORT),token=env.MI_MCP_TOKEN;
  if(!Number.isInteger(port)||port<1||port>65535||!token)throw Error('Set MI_MCP_PORT and MI_MCP_TOKEN to the running local service session.');
  const response=await transport('http://127.0.0.1:'+port+'/api/ipc',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),method:d.method,protocolVersion:1,token,payload:args})});
  if(!response.ok)throw Error('Local service rejected request: HTTP '+response.status);
  const body=await response.json();
  if(!body.ok)throw Error('Local IPC request rejected.');
  return body.result;
}
export async function handleMcp(message,call=callLocalTool){
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')return {jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:'Invalid Request'}};
  if(message.id===undefined)return null;
  const result=value=>({jsonrpc:'2.0',id:message.id,result:value});
  const error=(code,messageText)=>({jsonrpc:'2.0',id:message.id,error:{code,message:messageText}});
  if(message.method==='initialize'){
    const requested=message.params?.protocolVersion;
    return result({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(requested)?requested:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'lordmarketplaces-seo',version:'1.0.0'}});
  }
  if(message.method==='ping')return result({});
  if(message.method==='tools/list')return result({tools:toolList()});
  if(message.method==='tools/call'){
    try{const data=await call(message.params?.name,message.params?.arguments);return result({content:[{type:'text',text:JSON.stringify(data)}]});}
    catch(e){return result({isError:true,content:[{type:'text',text:String(e?.message||e)}]});}
  }
  return error(-32601,'Method not found');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input){
    let output;
    try{output=await handleMcp(JSON.parse(line));}
    catch{output={jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}};}
    if(output)process.stdout.write(JSON.stringify(output)+'\n');
  }
}
