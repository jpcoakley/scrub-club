// Run with the in-app Browser's javascript_tool on a GameSheet team-stats page:
//   https://gamesheetstats.com/seasons/<season>/teams/<team>/team-stats
// Returns a JSON string in stats.json's per-season shape: {skaters:[...], goalies:[...]}.
// The page's two tables (skaters, then goalies) are read by header text, so their
// column order doesn't matter. Keep "name" as returned: index.html joins it to the roster sheet.
const num=v=>{ v=(v||"").trim(); if(v===""||v==="-"||v==="--") return null; if(v[0]===".") v="0"+v; const n=Number(v); return isNaN(n)?v:n; };
const title=s=>(s||"").trim().toLowerCase().replace(/(^|[\s.'-])([a-z])/g,(m,p,c)=>p+c.toUpperCase());
const rows=t=>{
  const H=[...t.querySelectorAll("thead th")].map(th=>th.textContent.trim().replace(/\s*[↑↓]$/,""));
  return [...t.querySelectorAll("tbody tr")].map(tr=>{ const c=[...tr.children].map(td=>td.textContent.trim()); const o={}; H.forEach((h,i)=>o[h]=c[i]); return o; });
};
const [S,G]=[...document.querySelectorAll("table")];
JSON.stringify({
  skaters:rows(S).map(o=>({name:title(o.NAME),num:o["#"],pos:o.POS,gp:num(o.GP),g:num(o.G),a:num(o.A),pts:num(o.PTS),pim:num(o.PIM),ppg:num(o.PPG),shg:num(o.SHG),gwg:num(o.GWG),ht:num(o.HT)})),
  goalies:rows(G).map(o=>({name:title(o.NAME),num:o["#"],gp:num(o.GP),gs:num(o.GS),sa:num(o.SA),ga:num(o.GA),gaa:num(o.GAA),sv:num(o.SV),svp:num(o["SV%"]),w:num(o.W),l:num(o.L),t:num(o.T),otl:num(o.OTL),sol:num(o.SOL),so:num(o.SO),min:num(o.MIN)}))
});
