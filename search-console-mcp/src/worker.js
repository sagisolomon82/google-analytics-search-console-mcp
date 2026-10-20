// Google Search Console MCP Server v2.2.0 - Cloudflare Workers
// v2.2.0: +search_analytics_query, get_daily_trend, get_keyword_cannibalization, inspect_urls_batch, submit_sitemap, list_sites (20 tools)
// v2.1.0: inspect_url resolves the matching GSC property (sites.list) + normalizes Hebrew/relative URLs
// Full API: Search Analytics + URL Inspection + Sitemaps + Device/Country + CTR opportunities
// Same env vars: GSC_CLIENT_EMAIL, GSC_PRIVATE_KEY, SITE_URL, MCP_SECRET

const API_BASE = "https://searchconsole.googleapis.com";
const WM_BASE = "https://www.googleapis.com/webmasters/v3";

let _tok=null,_tokExp=0;
async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if(_tok&&now<_tokExp-300) return _tok;
  const b64u = s => btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const b64u2 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const hdr = b64u(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const pay = b64u(JSON.stringify({iss:env.GSC_CLIENT_EMAIL,scope:"https://www.googleapis.com/auth/webmasters",aud:"https://oauth2.googleapis.com/token",exp:now+3600,iat:now}));
  const inp = `${hdr}.${pay}`;
  const pem = env.GSC_PRIVATE_KEY.replace(/\\n/g,"\n");
  const raw = pem.replace("-----BEGIN PRIVATE KEY-----","").replace("-----END PRIVATE KEY-----","").replace(/\s/g,"");
  const key = await crypto.subtle.importKey("pkcs8",Uint8Array.from(atob(raw),c=>c.charCodeAt(0)),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(inp));
  const res = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${inp}.${b64u2(sig)}`});
  const d = await res.json();
  if(!d.access_token) throw new Error("Auth failed: "+JSON.stringify(d));
  _tok=d.access_token; _tokExp=now+(d.expires_in||3600);
  return d.access_token;
}

async function post(path, body, env, base) {
  const t = await getToken(env);
  const r = await fetch(`${base||API_BASE}${path}`,{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d = await r.json();
  if(d.error) throw new Error(d.error.message);
  return d;
}

async function get(path, env) {
  const t = await getToken(env);
  const r = await fetch(`${WM_BASE}${path}`,{headers:{Authorization:`Bearer ${t}`}});
  const d = await r.json();
  if(d.error) throw new Error(d.error.message);
  return d;
}

async function put(path, env) {
  const t = await getToken(env);
  const r = await fetch(`${WM_BASE}${path}`,{method:"PUT",headers:{Authorization:`Bearer ${t}`}});
  const txt = await r.text();
  if(!r.ok) { let m=`HTTP ${r.status}`; try{m=JSON.parse(txt).error?.message||m;}catch(e){if(txt)m+=": "+txt.slice(0,200);} throw new Error(m); }
  return txt?JSON.parse(txt):{};
}

function dr(days) {
  const e=new Date(), s=new Date();
  s.setDate(s.getDate()-days);
  return {startDate:s.toISOString().split("T")[0], endDate:e.toISOString().split("T")[0]};
}

const pct = n => `${((n||0)*100).toFixed(2)}%`;
const ps = n => (n||0).toFixed(1);

async function query(site, body, env) {
  return post(`/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, body, env, "https://searchconsole.googleapis.com");
}

const siteBase = site => (site||"").startsWith("sc-domain:")?`https://${site.slice(10)}/`:(site||"");
const listProps = async env => ((await get("/sites",env)).siteEntry||[]).map(s=>s.siteUrl);

// v2.2.0: shared by inspect_url + inspect_urls_batch (props = pre-fetched sites.list, fetched here if omitted)
async function inspectOne(url, env, site, props) {
  // v2.1.0: normalize URL + resolve the exact GSC property that contains it
  const base=siteBase(site);
  let raw=String(url||"").trim();
  try{raw=decodeURI(raw);}catch(e){}
  const inspectionUrl=new URL(raw,base||undefined).href;
  const host=new URL(inspectionUrl).hostname.replace(/^www\./,"");
  if(!props){props=[];try{props=await listProps(env);}catch(e){}}
  const cands=[];
  const add=s=>{if(s&&!cands.includes(s))cands.push(s);};
  props.filter(p=>p.startsWith("sc-domain:")&&(host===p.slice(10)||host.endsWith("."+p.slice(10)))).forEach(add);
  props.filter(p=>!p.startsWith("sc-domain:")&&inspectionUrl.startsWith(p)).sort((a,b)=>b.length-a.length).forEach(add);
  add(site);
  if(site&&!site.startsWith("sc-domain:")&&!site.endsWith("/"))add(site+"/");
  add(`sc-domain:${host}`);
  add(`https://www.${host}/`);
  add(`https://${host}/`);
  let d=null,lastErr=null,usedSite=null;
  for(const s of cands){
    try{d=await post("/v1/urlInspection/index:inspect",{inspectionUrl,siteUrl:s},env);usedSite=s;break;}
    catch(e){lastErr=e;}
  }
  if(!d)throw new Error(`${lastErr?.message||"Inspection failed"} | inspectionUrl=${inspectionUrl} | tried siteUrl: ${cands.join(", ")} | properties visible to service account: ${props.join(", ")||"none"}`);
  const idx=d.inspectionResult?.indexStatusResult||{};
  const mob=d.inspectionResult?.mobileUsabilityResult||{};
  return {
    url:inspectionUrl,
    property:usedSite,
    verdict:idx.verdict||"UNKNOWN",
    coverage_state:idx.coverageState||"Unknown",
    indexing_state:idx.indexingState||"Unknown",
    last_crawl:idx.lastCrawlTime||"Never crawled",
    google_canonical:idx.googleCanonical||"Not set",
    user_canonical:idx.userCanonical||"Not set",
    canonical_match:idx.googleCanonical===idx.userCanonical?"Yes":"No — potential issue",
    mobile_verdict:mob.verdict||"Unknown",
    mobile_issues:(mob.issues||[]).map(i=>i.issueMessage),
    sitemaps:idx.sitemap||[]
  };
}

async function pool(items, n, fn) {
  const out=new Array(items.length); let i=0;
  await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const k=i++;out[k]=await fn(items[k],k);}}));
  return out;
}

const TOOLS = [
  {name:"get_site_overview",description:"Overall clicks, impressions, CTR, position",inputSchema:{type:"object",properties:{days:{type:"number",default:28}}}},
  {name:"get_top_pages",description:"Top pages by clicks",inputSchema:{type:"object",properties:{days:{type:"number",default:28},limit:{type:"number",default:20}}}},
  {name:"get_top_keywords",description:"Top search queries",inputSchema:{type:"object",properties:{days:{type:"number",default:28},limit:{type:"number",default:30},page:{type:"string"}}}},
  {name:"get_keyword_opportunities",description:"Keywords pos 4-20 with high impressions — easy wins",inputSchema:{type:"object",properties:{days:{type:"number",default:90},limit:{type:"number",default:20},min_impressions:{type:"number",default:50}}}},
  {name:"get_page_keywords",description:"All keywords for a specific page",inputSchema:{type:"object",required:["page"],properties:{page:{type:"string"},days:{type:"number",default:28}}}},
  {name:"compare_periods",description:"Compare two time periods",inputSchema:{type:"object",properties:{current_days:{type:"number",default:28},previous_days:{type:"number",default:28}}}},
  {name:"get_device_breakdown",description:"Performance by device — mobile, desktop, tablet",inputSchema:{type:"object",properties:{days:{type:"number",default:28}}}},
  {name:"get_country_breakdown",description:"Performance by country",inputSchema:{type:"object",properties:{days:{type:"number",default:28},limit:{type:"number",default:10}}}},
  {name:"get_search_type_breakdown",description:"Performance by search type — web, image, video, news",inputSchema:{type:"object",properties:{days:{type:"number",default:28}}}},
  {name:"inspect_url",description:"Inspect a URL — indexing status, last crawl, canonical, mobile issues",inputSchema:{type:"object",required:["url"],properties:{url:{type:"string"}}}},
  {name:"get_sitemaps",description:"All submitted sitemaps — status, errors, pages submitted vs indexed",inputSchema:{type:"object",properties:{}}},
  {name:"get_ctr_opportunities",description:"Pages with high impressions but low CTR — fix titles to get more clicks",inputSchema:{type:"object",properties:{days:{type:"number",default:28},limit:{type:"number",default:15}}}},
  {name:"get_trending_keywords",description:"Keywords that gained or lost most clicks this week vs last week",inputSchema:{type:"object",properties:{limit:{type:"number",default:15}}}},
  {name:"generate_seo_report",description:"Full weekly SEO report — overview, wins, issues, recommendations",inputSchema:{type:"object",properties:{days:{type:"number",default:28}}}},
  {name:"search_analytics_query",description:"Flexible Search Analytics query — custom dates, dimensions, filters, search type, paging",inputSchema:{type:"object",properties:{days:{type:"number",default:28},start_date:{type:"string",description:"YYYY-MM-DD"},end_date:{type:"string",description:"YYYY-MM-DD"},dimensions:{type:"array",items:{type:"string",enum:["query","page","country","device","date","searchAppearance"]}},filters:{type:"array",items:{type:"object",required:["dimension","expression"],properties:{dimension:{type:"string",enum:["query","page","country","device","searchAppearance"]},operator:{type:"string",enum:["equals","notEquals","contains","notContains","includingRegex","excludingRegex"],default:"equals"},expression:{type:"string"}}}},type:{type:"string",enum:["web","image","video","news","discover","googleNews"],default:"web"},limit:{type:"number",default:100,maximum:25000},start_row:{type:"number",default:0}}}},
  {name:"get_daily_trend",description:"Daily clicks, impressions, CTR, position — optionally for one page or one keyword",inputSchema:{type:"object",properties:{days:{type:"number",default:28},page:{type:"string",description:"Exact page URL"},query:{type:"string",description:"Exact keyword"}}}},
  {name:"get_keyword_cannibalization",description:"Keywords where 2+ of your pages get impressions — possible cannibalization",inputSchema:{type:"object",properties:{days:{type:"number",default:28},min_impressions:{type:"number",default:20},limit:{type:"number",default:20}}}},
  {name:"inspect_urls_batch",description:"Inspect up to 20 URLs — verdict, coverage, last crawl, canonical match, mobile",inputSchema:{type:"object",required:["urls"],properties:{urls:{type:"array",items:{type:"string"},maxItems:20}}}},
  {name:"submit_sitemap",description:"Submit (or resubmit) a sitemap to Google Search Console",inputSchema:{type:"object",required:["sitemap_url"],properties:{sitemap_url:{type:"string",description:"Full URL or path relative to the site"}}}},
  {name:"list_sites",description:"All GSC properties the service account can access, with permission level",inputSchema:{type:"object",properties:{}}}
];

async function handle(name, args, env) {
  const site = env.SITE_URL;
  const enc = encodeURIComponent(site);

  if(name==="get_site_overview") {
    const d=await query(site,{...dr(args.days||28),dimensions:[]},env);
    const r=d.rows?.[0]||{};
    return {period:`Last ${args.days||28} days`,clicks:r.clicks||0,impressions:r.impressions||0,ctr:pct(r.ctr),position:ps(r.position)};
  }

  if(name==="get_top_pages") {
    const d=await query(site,{...dr(args.days||28),dimensions:["page"],rowLimit:args.limit||20},env);
    return (d.rows||[]).map(r=>({page:r.keys[0].replace(site,"")||"/",clicks:r.clicks,impressions:r.impressions,ctr:pct(r.ctr),position:ps(r.position)}));
  }

  if(name==="get_top_keywords") {
    const body={...dr(args.days||28),dimensions:["query"],rowLimit:args.limit||30};
    if(args.page) body.dimensionFilterGroups=[{filters:[{dimension:"page",operator:"equals",expression:args.page}]}];
    const d=await query(site,body,env);
    return (d.rows||[]).map(r=>({keyword:r.keys[0],clicks:r.clicks,impressions:r.impressions,ctr:pct(r.ctr),position:ps(r.position)}));
  }

  if(name==="get_keyword_opportunities") {
    const d=await query(site,{...dr(args.days||90),dimensions:["query"],rowLimit:500},env);
    return (d.rows||[]).filter(r=>r.position>=4&&r.position<=20&&r.impressions>=(args.min_impressions||50))
      .sort((a,b)=>b.impressions-a.impressions).slice(0,args.limit||20)
      .map(r=>({keyword:r.keys[0],position:ps(r.position),impressions:r.impressions,clicks:r.clicks,ctr:pct(r.ctr),
        opportunity:r.position<=10?"🟡 In top 10 — push to top 3":"🔵 Page 2 — push to page 1",
        potential_extra_clicks:Math.round(r.impressions*0.25-r.clicks)}));
  }

  if(name==="get_page_keywords") {
    const d=await query(site,{...dr(args.days||28),dimensions:["query"],rowLimit:50,
      dimensionFilterGroups:[{filters:[{dimension:"page",operator:"equals",expression:args.page}]}]},env);
    return (d.rows||[]).map(r=>({keyword:r.keys[0],clicks:r.clicks,impressions:r.impressions,ctr:pct(r.ctr),position:ps(r.position)}));
  }

  if(name==="compare_periods") {
    const cd=args.current_days||28,pd=args.previous_days||28;
    const cE=new Date(),cS=new Date(); cS.setDate(cS.getDate()-cd);
    const pE=new Date(cS),pS=new Date(pE); pS.setDate(pS.getDate()-pd);
    const f=d=>d.toISOString().split("T")[0];
    const [c,p]=await Promise.all([
      query(site,{startDate:f(cS),endDate:f(cE),dimensions:[]},env),
      query(site,{startDate:f(pS),endDate:f(pE),dimensions:[]},env)
    ]);
    const cr=c.rows?.[0]||{},pr=p.rows?.[0]||{};
    const chg=(a,b)=>b?`${((a-b)/b*100).toFixed(1)}%`:"—";
    return {
      current:`${f(cS)} to ${f(cE)}`,previous:`${f(pS)} to ${f(pE)}`,
      clicks:{current:cr.clicks||0,previous:pr.clicks||0,change:chg(cr.clicks,pr.clicks)},
      impressions:{current:cr.impressions||0,previous:pr.impressions||0,change:chg(cr.impressions,pr.impressions)},
      ctr:{current:pct(cr.ctr),previous:pct(pr.ctr)},
      position:{current:ps(cr.position),previous:ps(pr.position),note:"Lower = better"}
    };
  }

  if(name==="get_device_breakdown") {
    const d=await query(site,{...dr(args.days||28),dimensions:["device"],rowLimit:10},env);
    return (d.rows||[]).map(r=>({device:r.keys[0],clicks:r.clicks,impressions:r.impressions,ctr:pct(r.ctr),position:ps(r.position)}));
  }

  if(name==="get_country_breakdown") {
    const d=await query(site,{...dr(args.days||28),dimensions:["country"],rowLimit:args.limit||10},env);
    return (d.rows||[]).map(r=>({country:r.keys[0],clicks:r.clicks,impressions:r.impressions,ctr:pct(r.ctr),position:ps(r.position)}));
  }

  if(name==="get_search_type_breakdown") {
    const types=["web","image","video","news"];
    const results=await Promise.all(types.map(t=>
      query(site,{...dr(args.days||28),dimensions:[],type:t},env).catch(()=>({rows:[]}))
    ));
    return types.map((t,i)=>{const r=results[i].rows?.[0]||{};return{type:t,clicks:r.clicks||0,impressions:r.impressions||0,ctr:pct(r.ctr),position:ps(r.position)};}).filter(r=>r.impressions>0);
  }

  if(name==="inspect_url") {
    return inspectOne(args.url,env,site);
  }

  if(name==="get_sitemaps") {
    const d=await get(`/sites/${enc}/sitemaps`,env);
    return (d.sitemap||[]).map(s=>({
      path:s.path,last_submitted:s.lastSubmitted,last_downloaded:s.lastDownloaded,
      warnings:s.warnings||0,errors:s.errors||0,
      contents:(s.contents||[]).map(c=>({type:c.type,submitted:c.submitted,indexed:c.indexed}))
    }));
  }

  if(name==="get_ctr_opportunities") {
    const d=await query(site,{...dr(args.days||28),dimensions:["page"],rowLimit:500},env);
    return (d.rows||[]).filter(r=>r.impressions>=100&&r.ctr<0.04)
      .sort((a,b)=>b.impressions-a.impressions).slice(0,args.limit||15)
      .map(r=>({page:r.keys[0].replace(site,"")||"/",impressions:r.impressions,clicks:r.clicks,
        ctr:pct(r.ctr),position:ps(r.position),
        fix:"Improve page title and meta description",
        potential_extra_clicks:Math.round(r.impressions*0.05-r.clicks)}));
  }

  if(name==="get_trending_keywords") {
    const now=new Date();
    const w1e=new Date(now),w1s=new Date(now); w1s.setDate(w1s.getDate()-7);
    const w2e=new Date(w1s),w2s=new Date(w2e); w2s.setDate(w2s.getDate()-7);
    const f=d=>d.toISOString().split("T")[0];
    const [cur,prv]=await Promise.all([
      query(site,{startDate:f(w1s),endDate:f(w1e),dimensions:["query"],rowLimit:200},env),
      query(site,{startDate:f(w2s),endDate:f(w2e),dimensions:["query"],rowLimit:200},env)
    ]);
    const pm={};(prv.rows||[]).forEach(r=>{pm[r.keys[0]]=r.clicks;});
    return (cur.rows||[]).map(r=>({
      keyword:r.keys[0],this_week:r.clicks,last_week:pm[r.keys[0]]||0,
      change:r.clicks-(pm[r.keys[0]]||0),
      trend:r.clicks>(pm[r.keys[0]]||0)?"📈 Up":r.clicks<(pm[r.keys[0]]||0)?"📉 Down":"→ Flat"
    })).filter(r=>r.this_week>0).sort((a,b)=>b.change-a.change).slice(0,args.limit||15);
  }

  if(name==="generate_seo_report") {
    const days=args.days||28;
    const [ov,pages,opps,ctr,trends,devices,sitemaps]=await Promise.all([
      handle("get_site_overview",{days},env),
      handle("get_top_pages",{days,limit:5},env),
      handle("get_keyword_opportunities",{days:90,limit:5},env),
      handle("get_ctr_opportunities",{days,limit:5},env),
      handle("get_trending_keywords",{limit:5},env),
      handle("get_device_breakdown",{days},env),
      handle("get_sitemaps",{},env),
    ]);
    const recs=[];
    if(opps[0]) recs.push(`Push "${opps[0].keyword}" from pos ${opps[0].position} to top 3 — ${opps[0].impressions} impressions waiting`);
    if(ctr[0]) recs.push(`Fix title/meta on "${ctr[0].page}" — ${ctr[0].impressions} impressions but only ${ctr[0].ctr} CTR`);
    const loser=trends.find(t=>t.trend==="📉 Down");
    if(loser) recs.push(`"${loser.keyword}" losing clicks — check for ranking drop`);
    return {generated:new Date().toISOString().split("T")[0],period:`Last ${days} days`,overview:ov,top_pages:pages,keyword_opportunities:opps,ctr_issues:ctr,trending:trends,devices,sitemaps,recommendations:recs};
  }

  if(name==="search_analytics_query") {
    const dims=Array.isArray(args.dimensions)?args.dimensions:[];
    const d0=dr(args.days||28);
    const body={startDate:args.start_date||d0.startDate,endDate:args.end_date||d0.endDate,dimensions:dims,type:args.type||"web",
      rowLimit:Math.min(Math.max(args.limit||100,1),25000),startRow:args.start_row||0};
    if(Array.isArray(args.filters)&&args.filters.length) body.dimensionFilterGroups=[{groupType:"and",filters:args.filters.map(f=>({dimension:f.dimension,operator:f.operator||"equals",expression:String(f.expression)}))}];
    const d=await query(site,body,env);
    const rows=(d.rows||[]).map(r=>{const o={};dims.forEach((k,i)=>{o[k]=r.keys?.[i];});return {...o,clicks:r.clicks,impressions:r.impressions,ctr:pct(r.ctr),position:ps(r.position)};});
    return {start_date:body.startDate,end_date:body.endDate,type:body.type,dimensions:dims,start_row:body.startRow,row_count:rows.length,rows};
  }

  if(name==="get_daily_trend") {
    const days=args.days||28;
    const body={...dr(days),dimensions:["date"],rowLimit:Math.min(days+10,25000)};
    const f=[];
    if(args.page) f.push({dimension:"page",operator:"equals",expression:args.page});
    if(args.query) f.push({dimension:"query",operator:"equals",expression:args.query});
    if(f.length) body.dimensionFilterGroups=[{filters:f}];
    const d=await query(site,body,env);
    return (d.rows||[]).sort((a,b)=>a.keys[0].localeCompare(b.keys[0]))
      .map(r=>({date:r.keys[0],clicks:r.clicks,impressions:r.impressions,ctr:pct(r.ctr),position:ps(r.position)}));
  }

  if(name==="get_keyword_cannibalization") {
    const d=await query(site,{...dr(args.days||28),dimensions:["query","page"],rowLimit:25000},env);
    const g={};
    (d.rows||[]).forEach(r=>{(g[r.keys[0]]=g[r.keys[0]]||[]).push(r);});
    return Object.entries(g).filter(([,rs])=>rs.length>1)
      .map(([q,rs])=>({keyword:q,page_count:rs.length,total_impressions:rs.reduce((a,r)=>a+r.impressions,0),total_clicks:rs.reduce((a,r)=>a+r.clicks,0),
        pages:rs.sort((a,b)=>b.impressions-a.impressions).map(r=>({page:r.keys[1],clicks:r.clicks,impressions:r.impressions,position:ps(r.position)}))}))
      .filter(x=>x.total_impressions>=(args.min_impressions??20))
      .sort((a,b)=>b.total_impressions-a.total_impressions).slice(0,args.limit||20);
  }

  if(name==="inspect_urls_batch") {
    const urls=Array.isArray(args.urls)?args.urls.filter(u=>u&&String(u).trim()):[];
    if(!urls.length) throw new Error("urls must be a non-empty array");
    if(urls.length>20) throw new Error(`Max 20 URLs per batch (got ${urls.length})`);
    let props=[];
    try{props=await listProps(env);}catch(e){}
    const results=await pool(urls,5,async u=>{
      try{const r=await inspectOne(u,env,site,props);
        return {url:r.url,property:r.property,verdict:r.verdict,coverage_state:r.coverage_state,last_crawl:r.last_crawl,canonical_match:r.canonical_match,mobile_verdict:r.mobile_verdict};}
      catch(e){return {url:String(u),error:e.message};}
    });
    return {total:results.length,ok:results.filter(r=>!r.error).length,failed:results.filter(r=>r.error).length,results};
  }

  if(name==="submit_sitemap") {
    const raw=String(args.sitemap_url||"").trim();
    if(!raw) throw new Error("sitemap_url is required");
    const url=new URL(raw,siteBase(site)||undefined).href;
    await put(`/sites/${enc}/sitemaps/${encodeURIComponent(url)}`,env);
    return {submitted:url,status:"ok"};
  }

  if(name==="list_sites") {
    const d=await get("/sites",env);
    const sites=(d.siteEntry||[]).map(s=>({siteUrl:s.siteUrl,permissionLevel:s.permissionLevel,is_configured:s.siteUrl===site}));
    return {configured_site:site,configured_found:sites.some(s=>s.is_configured),count:sites.length,sites};
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMCP(body,env) {
  const {method,params,id}=body;
  try {
    if(method==="initialize") return {jsonrpc:"2.0",id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"gsc-mcp-v2",version:"2.2.1"}}};
    if(method==="tools/list") return {jsonrpc:"2.0",id,result:{tools:TOOLS}};
    if(method==="tools/call") {
      const {name,arguments:args}=params;
      const result=await handle(name,args||{},env);
      return {jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(result,null,2)}]}};
    }
    return {jsonrpc:"2.0",id,error:{code:-32601,message:`Unknown: ${method}`}};
  } catch(err) {
    return {jsonrpc:"2.0",id,error:{code:-32000,message:err.message}};
  }
}

export default {
  async fetch(req,env) {
    const h={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST,GET,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"};
    if(req.method==="OPTIONS") return new Response(null,{headers:h});
    // MCP endpoint has no SSE stream: per MCP spec GET must be 405 (stops mcp-remote reconnect loops)
    if((req.method==="GET"||req.method==="HEAD")&&new URL(req.url).pathname.replace(/\/+$/,"")==="/mcp") return new Response(null,{status:405,headers:{...h,Allow:"POST"}});
    if(req.method==="GET") return new Response(JSON.stringify({status:"ok",server:"gsc-mcp-v2",tools:TOOLS.length}),{headers:h});
    const auth=req.headers.get("Authorization")?.replace("Bearer ","");
    if(env.MCP_SECRET&&auth!==env.MCP_SECRET) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:h});
    try {
      const body=await req.json();
      const isNotif=(m)=>m&&typeof m==="object"&&m.id===undefined&&typeof m.method==="string";
      if(Array.isArray(body)){const out=[];for(const m of body){if(!isNotif(m))out.push(await handleMCP(m,env));}return out.length?new Response(JSON.stringify(out),{headers:h}):new Response(null,{status:202,headers:{"Access-Control-Allow-Origin":"*"}});}
      if(isNotif(body)) return new Response(null,{status:202,headers:{"Access-Control-Allow-Origin":"*"}});
      return new Response(JSON.stringify(await handleMCP(body,env)),{headers:h});
    } catch(err) {
      return new Response(JSON.stringify({error:err.message}),{status:500,headers:h});
    }
  }
};
