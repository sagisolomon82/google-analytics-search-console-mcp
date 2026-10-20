// Google Analytics 4 MCP Server - Cloudflare Workers
// Free forever, always on
//
// Environment variables:
//   GA4_CLIENT_EMAIL = service account email (client_email)
//   GA4_PRIVATE_KEY  = service account private key (PEM, \n-escaped)
//   GA4_PROPERTY_ID  = your GA4 property ID (numbers only)
//   MCP_SECRET       = any long random string (Bearer token)

const API_BASE = "https://analyticsdata.googleapis.com/v1beta";

// ── AUTH (same as GSC) ──────────────────────────────────
async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const b64u = s => btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const b64u2 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const hdr = b64u(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const pay = b64u(JSON.stringify({
    iss: env.GA4_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now+3600, iat: now
  }));
  const inp = `${hdr}.${pay}`;
  const pem = env.GA4_PRIVATE_KEY.replace(/\\n/g,"\n");
  const raw = pem.replace("-----BEGIN PRIVATE KEY-----","").replace("-----END PRIVATE KEY-----","").replace(/\s/g,"");
  const key = await crypto.subtle.importKey("pkcs8",Uint8Array.from(atob(raw),c=>c.charCodeAt(0)),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(inp));
  const res = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${inp}.${b64u2(sig)}`});
  const d = await res.json();
  if(!d.access_token) throw new Error("Auth failed: "+JSON.stringify(d));
  return d.access_token;
}

async function gaPost(path, body, env) {
  const t = await getToken(env);
  const r = await fetch(`${API_BASE}${path}`,{method:"POST",headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d = await r.json();
  if(d.error) throw new Error(d.error.message);
  return d;
}

// ── HELPERS ─────────────────────────────────────────────
function dr(days) {
  return { startDate: `${days}daysAgo`, endDate: "today" };
}

function extractRows(data, dims, mets) {
  return (data.rows || []).map(row => {
    const obj = {};
    (dims || []).forEach((d,i) => { obj[d] = row.dimensionValues?.[i]?.value || ""; });
    (mets || []).forEach((m,i) => { obj[m] = parseFloat(row.metricValues?.[i]?.value || 0); });
    return obj;
  });
}

// ── TOOLS ───────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_overview",
    description: "Overall site performance — sessions, users, pageviews, bounce rate, avg session duration",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 } }}
  },
  {
    name: "get_traffic_sources",
    description: "Where traffic comes from — organic, direct, social, paid, referral",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 }, limit: { type: "number", default: 10 } }}
  },
  {
    name: "get_top_pages",
    description: "Most visited pages — pageviews, users, avg time on page, bounce rate",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 }, limit: { type: "number", default: 20 } }}
  },
  {
    name: "get_user_behavior",
    description: "How users behave — new vs returning, session duration, pages per session, engagement rate",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 } }}
  },
  {
    name: "get_device_breakdown",
    description: "Traffic split by device — mobile, desktop, tablet",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 } }}
  },
  {
    name: "get_country_breakdown",
    description: "Traffic split by country",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 }, limit: { type: "number", default: 10 } }}
  },
  {
    name: "get_conversions",
    description: "Conversion events — purchases, signups, form submits, any goals configured in GA4",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 } }}
  },
  {
    name: "get_landing_pages",
    description: "Top landing pages — first page users see, with sessions and bounce rate",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 }, limit: { type: "number", default: 15 } }}
  },
  {
    name: "get_page_performance",
    description: "Detailed performance for a specific page — users, sessions, time on page, exits",
    inputSchema: { type: "object", required: ["page"], properties: { page: { type: "string", description: "Page path e.g. /course/" }, days: { type: "number", default: 28 } }}
  },
  {
    name: "compare_periods",
    description: "Compare two time periods — spot traffic trends and drops",
    inputSchema: { type: "object", properties: { current_days: { type: "number", default: 28 }, previous_days: { type: "number", default: 28 } }}
  },
  {
    name: "get_realtime",
    description: "Active users on site right now, by page and country",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_funnel_analysis",
    description: "Analyze drop-off from landing page to purchase — sessions, add to cart, checkout, purchase rates",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 } }}
  },
  {
    name: "get_purchases_by_source",
    description: "Purchases & revenue by traffic source — ecommercePurchases, purchaseRevenue, transactions, sessions grouped by source/medium or default channel group, ordered by revenue, with totals",
    inputSchema: { type: "object", properties: {
      start_date: { type: "string", default: "28daysAgo", description: "YYYY-MM-DD or GA relative (e.g. 30daysAgo, yesterday, today)" },
      end_date: { type: "string", default: "today", description: "YYYY-MM-DD or GA relative" },
      group_by: { type: "string", enum: ["source_medium","channel_group"], default: "source_medium" },
      property_id: { type: "string", description: "Optional GA4 property ID override (numbers only); defaults to configured property" },
      limit: { type: "number", default: 50 }
    }}
  },
  {
    name: "generate_analytics_report",
    description: "Full weekly analytics report — overview, traffic sources, top pages, behavior, conversions, recommendations",
    inputSchema: { type: "object", properties: { days: { type: "number", default: 28 } }}
  }
];

// ── HANDLERS ────────────────────────────────────────────
async function handle(name, args, env) {
  const prop = `/properties/${env.GA4_PROPERTY_ID}`;
  const days = args.days || 28;

  if(name === "get_overview") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      metrics: [
        {name:"sessions"},{name:"activeUsers"},{name:"screenPageViews"},
        {name:"bounceRate"},{name:"averageSessionDuration"},{name:"engagementRate"}
      ]
    }, env);
    const r = data.rows?.[0]?.metricValues || [];
    return {
      period: `Last ${days} days`,
      sessions: parseInt(r[0]?.value||0).toLocaleString(),
      active_users: parseInt(r[1]?.value||0).toLocaleString(),
      pageviews: parseInt(r[2]?.value||0).toLocaleString(),
      bounce_rate: `${(parseFloat(r[3]?.value||0)*100).toFixed(1)}%`,
      avg_session_duration: `${Math.round(parseFloat(r[4]?.value||0))}s`,
      engagement_rate: `${(parseFloat(r[5]?.value||0)*100).toFixed(1)}%`,
    };
  }

  if(name === "get_purchases_by_source") {
    const okDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) || /^(\d+daysAgo|today|yesterday)$/.test(v);
    const startDate = String(args.start_date || "28daysAgo").trim();
    const endDate = String(args.end_date || "today").trim();
    if(!okDate(startDate) || !okDate(endDate)) throw new Error("start_date/end_date must be YYYY-MM-DD or NdaysAgo/today/yesterday");
    const groupBy = args.group_by || "source_medium";
    if(!["source_medium","channel_group"].includes(groupBy)) throw new Error("group_by must be source_medium or channel_group");
    const pid = args.property_id ? String(args.property_id).replace(/^properties\//,"").trim() : env.GA4_PROPERTY_ID;
    if(!/^\d+$/.test(pid)) throw new Error("property_id must be numeric");
    const dims = groupBy === "channel_group" ? ["sessionDefaultChannelGroup"] : ["sessionSource","sessionMedium"];
    const mets = ["ecommercePurchases","purchaseRevenue","transactions","sessions"];
    const limit = Math.max(1, Math.min(parseInt(args.limit || 50), 10000));
    const data = await gaPost(`/properties/${pid}:runReport`, {
      dateRanges: [{ startDate, endDate }],
      dimensions: dims.map(name => ({name})),
      metrics: mets.map(name => ({name})),
      orderBys: [{ metric: { metricName: "purchaseRevenue" }, desc: true }],
      metricAggregations: ["TOTAL"],
      limit
    }, env);
    const rows = extractRows(data, dims, mets).map(r => {
      const o = groupBy === "channel_group"
        ? { channel_group: r.sessionDefaultChannelGroup }
        : { source_medium: `${r.sessionSource} / ${r.sessionMedium}`, source: r.sessionSource, medium: r.sessionMedium };
      return { ...o, purchases: r.ecommercePurchases, revenue: Math.round(r.purchaseRevenue*100)/100,
        transactions: r.transactions, sessions: r.sessions,
        conversion_rate: r.sessions ? `${(r.transactions/r.sessions*100).toFixed(2)}%` : "0%" };
    });
    const tv = data.totals?.[0]?.metricValues || [];
    const tot = mets.reduce((a,m,i)=>{ a[m] = parseFloat(tv[i]?.value || 0); return a; }, {});
    return {
      property_id: pid, start_date: startDate, end_date: endDate, group_by: groupBy,
      currency: data.metadata?.currencyCode || null,
      row_count: data.rowCount || rows.length,
      totals: { purchases: tot.ecommercePurchases, revenue: Math.round(tot.purchaseRevenue*100)/100,
        transactions: tot.transactions, sessions: tot.sessions },
      rows
    };
  }

  if(name === "get_traffic_sources") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"sessionDefaultChannelGroup"}],
      metrics: [{name:"sessions"},{name:"activeUsers"},{name:"bounceRate"},{name:"conversions"}],
      limit: args.limit || 10,
      orderBys: [{metric:{metricName:"sessions"},desc:true}]
    }, env);
    return (data.rows||[]).map(r => ({
      channel: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      users: parseInt(r.metricValues[1].value),
      bounce_rate: `${(parseFloat(r.metricValues[2].value)*100).toFixed(1)}%`,
      conversions: parseInt(r.metricValues[3].value),
    }));
  }

  if(name === "get_top_pages") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"pagePath"},{name:"pageTitle"}],
      metrics: [{name:"screenPageViews"},{name:"activeUsers"},{name:"averageSessionDuration"},{name:"bounceRate"}],
      limit: args.limit || 20,
      orderBys: [{metric:{metricName:"screenPageViews"},desc:true}]
    }, env);
    return (data.rows||[]).map(r => ({
      path: r.dimensionValues[0].value,
      title: r.dimensionValues[1].value,
      pageviews: parseInt(r.metricValues[0].value),
      users: parseInt(r.metricValues[1].value),
      avg_time: `${Math.round(parseFloat(r.metricValues[2].value))}s`,
      bounce_rate: `${(parseFloat(r.metricValues[3].value)*100).toFixed(1)}%`,
    }));
  }

  if(name === "get_user_behavior") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"newVsReturning"}],
      metrics: [{name:"activeUsers"},{name:"sessions"},{name:"screenPageViews"},{name:"averageSessionDuration"},{name:"engagementRate"}],
    }, env);
    return (data.rows||[]).map(r => ({
      user_type: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value),
      sessions: parseInt(r.metricValues[1].value),
      pageviews: parseInt(r.metricValues[2].value),
      avg_session: `${Math.round(parseFloat(r.metricValues[3].value))}s`,
      engagement_rate: `${(parseFloat(r.metricValues[4].value)*100).toFixed(1)}%`,
    }));
  }

  if(name === "get_device_breakdown") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"deviceCategory"}],
      metrics: [{name:"sessions"},{name:"activeUsers"},{name:"bounceRate"},{name:"conversions"}],
      orderBys: [{metric:{metricName:"sessions"},desc:true}]
    }, env);
    return (data.rows||[]).map(r => ({
      device: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      users: parseInt(r.metricValues[1].value),
      bounce_rate: `${(parseFloat(r.metricValues[2].value)*100).toFixed(1)}%`,
      conversions: parseInt(r.metricValues[3].value),
    }));
  }

  if(name === "get_country_breakdown") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"country"}],
      metrics: [{name:"sessions"},{name:"activeUsers"},{name:"conversions"}],
      limit: args.limit || 10,
      orderBys: [{metric:{metricName:"sessions"},desc:true}]
    }, env);
    return (data.rows||[]).map(r => ({
      country: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      users: parseInt(r.metricValues[1].value),
      conversions: parseInt(r.metricValues[2].value),
    }));
  }

  if(name === "get_conversions") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"eventName"}],
      metrics: [{name:"eventCount"},{name:"conversions"},{name:"totalRevenue"}],
      orderBys: [{metric:{metricName:"conversions"},desc:true}]
    }, env);
    return (data.rows||[])
      .filter(r => parseInt(r.metricValues[1].value) > 0 || r.dimensionValues[0].value.includes("purchase"))
      .map(r => ({
        event: r.dimensionValues[0].value,
        count: parseInt(r.metricValues[0].value),
        conversions: parseInt(r.metricValues[1].value),
        revenue: parseFloat(r.metricValues[2].value).toFixed(2),
      }));
  }

  if(name === "get_landing_pages") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"landingPage"}],
      metrics: [{name:"sessions"},{name:"activeUsers"},{name:"bounceRate"},{name:"conversions"}],
      limit: args.limit || 15,
      orderBys: [{metric:{metricName:"sessions"},desc:true}]
    }, env);
    return (data.rows||[]).map(r => ({
      page: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      users: parseInt(r.metricValues[1].value),
      bounce_rate: `${(parseFloat(r.metricValues[2].value)*100).toFixed(1)}%`,
      conversions: parseInt(r.metricValues[3].value),
    }));
  }

  if(name === "get_page_performance") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"pagePath"}],
      metrics: [{name:"screenPageViews"},{name:"activeUsers"},{name:"averageSessionDuration"},{name:"bounceRate"},{name:"exits"}],
      dimensionFilter: {
        filter: {
          fieldName: "pagePath",
          stringFilter: { matchType: "CONTAINS", value: args.page }
        }
      }
    }, env);
    return (data.rows||[]).map(r => ({
      path: r.dimensionValues[0].value,
      pageviews: parseInt(r.metricValues[0].value),
      users: parseInt(r.metricValues[1].value),
      avg_time: `${Math.round(parseFloat(r.metricValues[2].value))}s`,
      bounce_rate: `${(parseFloat(r.metricValues[3].value)*100).toFixed(1)}%`,
      exits: parseInt(r.metricValues[4].value),
    }));
  }

  if(name === "compare_periods") {
    const cd = args.current_days||28, pd = args.previous_days||28;
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(cd), {startDate:`${cd+pd}daysAgo`, endDate:`${cd+1}daysAgo`}],
      metrics: [{name:"sessions"},{name:"activeUsers"},{name:"screenPageViews"},{name:"bounceRate"},{name:"conversions"}],
    }, env);
    const cur = data.rows?.[0]?.metricValues||[];
    const prv = data.rows?.[1]?.metricValues||[];
    const chg = (a,b) => b ? `${((a-b)/b*100).toFixed(1)}%` : "—";
    const v = (r,i) => parseFloat(r[i]?.value||0);
    return {
      current_period: `Last ${cd} days`,
      previous_period: `Prior ${pd} days`,
      sessions: { current: Math.round(v(cur,0)), previous: Math.round(v(prv,0)), change: chg(v(cur,0),v(prv,0)) },
      users: { current: Math.round(v(cur,1)), previous: Math.round(v(prv,1)), change: chg(v(cur,1),v(prv,1)) },
      pageviews: { current: Math.round(v(cur,2)), previous: Math.round(v(prv,2)), change: chg(v(cur,2),v(prv,2)) },
      bounce_rate: { current: `${(v(cur,3)*100).toFixed(1)}%`, previous: `${(v(prv,3)*100).toFixed(1)}%` },
      conversions: { current: Math.round(v(cur,4)), previous: Math.round(v(prv,4)), change: chg(v(cur,4),v(prv,4)) },
    };
  }

  if(name === "get_realtime") {
    const data = await gaPost(`${prop}:runRealtimeReport`, {
      dimensions: [{name:"unifiedScreenName"},{name:"country"}],
      metrics: [{name:"activeUsers"}],
      limit: 20,
    }, env);
    const total = data.rows?.reduce((s,r) => s + parseInt(r.metricValues[0].value), 0) || 0;
    const pages = {};
    (data.rows||[]).forEach(r => {
      const page = r.dimensionValues[0].value;
      pages[page] = (pages[page]||0) + parseInt(r.metricValues[0].value);
    });
    return {
      active_users_right_now: total,
      by_page: Object.entries(pages).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([page,users])=>({page,users})),
    };
  }

  if(name === "get_funnel_analysis") {
    const data = await gaPost(`${prop}:runReport`, {
      dateRanges: [dr(days)],
      dimensions: [{name:"eventName"}],
      metrics: [{name:"eventCount"},{name:"totalUsers"}],
      dimensionFilter: {
        filter: {
          fieldName: "eventName",
          inListFilter: { values: ["session_start","view_item","add_to_cart","begin_checkout","purchase"] }
        }
      }
    }, env);
    const events = {};
    (data.rows||[]).forEach(r => {
      events[r.dimensionValues[0].value] = {
        events: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value)
      };
    });
    const steps = ["session_start","view_item","add_to_cart","begin_checkout","purchase"];
    const funnel = steps.map((step, i) => {
      const curr = events[step]?.users || 0;
      const prev = i > 0 ? (events[steps[i-1]]?.users || 0) : curr;
      return {
        step,
        users: curr,
        drop_off: i > 0 && prev > 0 ? `${(100-(curr/prev*100)).toFixed(1)}%` : "—",
        conversion_rate: i > 0 && prev > 0 ? `${(curr/prev*100).toFixed(1)}%` : "100%",
      };
    });
    return { period: `Last ${days} days`, funnel };
  }

  if(name === "generate_analytics_report") {
    const [overview, sources, pages, behavior, devices, conversions, landing] = await Promise.all([
      handle("get_overview", {days}, env),
      handle("get_traffic_sources", {days, limit:5}, env),
      handle("get_top_pages", {days, limit:5}, env),
      handle("get_user_behavior", {days}, env),
      handle("get_device_breakdown", {days}, env),
      handle("get_funnel_analysis", {days}, env),
      handle("get_landing_pages", {days, limit:5}, env),
    ]);
    const recs = [];
    const mobile = devices.find(d=>d.device==="mobile");
    const desktop = devices.find(d=>d.device==="desktop");
    if(mobile && desktop && parseFloat(mobile.bounce_rate) > parseFloat(desktop.bounce_rate)+10) {
      recs.push(`Mobile bounce rate (${mobile.bounce_rate}) much higher than desktop (${desktop.bounce_rate}) — check mobile UX`);
    }
    const organic = sources.find(s=>s.channel?.toLowerCase().includes("organic"));
    const paid = sources.find(s=>s.channel?.toLowerCase().includes("paid"));
    if(organic && paid) {
      recs.push(`Organic: ${organic.sessions} sessions vs Paid: ${paid.sessions} sessions — ${organic.sessions > paid.sessions ? "organic is working well" : "consider more SEO investment"}`);
    }
    const purchase = conversions.funnel?.find(f=>f.step==="purchase");
    const checkout = conversions.funnel?.find(f=>f.step==="begin_checkout");
    if(checkout && purchase && parseFloat(purchase.conversion_rate) < 30) {
      recs.push(`Only ${purchase.conversion_rate} of people who start checkout complete purchase — checkout page needs improvement`);
    }
    return {
      generated: new Date().toISOString().split("T")[0],
      period: `Last ${days} days`,
      overview, traffic_sources: sources, top_pages: pages,
      user_behavior: behavior, devices, funnel: conversions.funnel,
      top_landing_pages: landing, recommendations: recs
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── MCP + ENTRY POINT ───────────────────────────────────
async function handleMCP(body, env) {
  const {method,params,id} = body;
  try {
    if(method==="initialize") return {jsonrpc:"2.0",id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"ga4-mcp",version:"1.0.1"}}};
    if(method==="tools/list") return {jsonrpc:"2.0",id,result:{tools:TOOLS}};
    if(method==="tools/call") {
      const result = await handle(params.name, params.arguments||{}, env);
      return {jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(result,null,2)}]}};
    }
    return {jsonrpc:"2.0",id,error:{code:-32601,message:`Unknown: ${method}`}};
  } catch(err) {
    return {jsonrpc:"2.0",id,error:{code:-32000,message:err.message}};
  }
}

export default {
  async fetch(req, env) {
    const h = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST,GET,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"};
    if(req.method==="OPTIONS") return new Response(null,{headers:h});
    // MCP endpoint has no SSE stream: per MCP spec GET must be 405 (stops mcp-remote reconnect loops)
    if((req.method==="GET"||req.method==="HEAD")&&new URL(req.url).pathname.replace(/\/+$/,"")==="/mcp") return new Response(null,{status:405,headers:{...h,Allow:"POST"}});
    if(req.method==="GET") return new Response(JSON.stringify({status:"ok",server:"ga4-mcp",tools:TOOLS.length}),{headers:h});
    const auth = req.headers.get("Authorization")?.replace("Bearer ","");
    if(env.MCP_SECRET && auth!==env.MCP_SECRET) return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:h});
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
