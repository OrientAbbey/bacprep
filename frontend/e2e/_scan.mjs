import { chromium } from "playwright-core";
import fs from "node:fs";
const b = await chromium.launch({ executablePath: "/tmp/chromium", args: fs.readFileSync("/tmp/chrom_args.txt","utf8").trim().split(" ").concat("--headless=new") });
const ctx = await b.newContext({ baseURL: "http://localhost:8765", viewport:{width:1280,height:900} });
await ctx.addInitScript(() => localStorage.setItem("bacprep-lang", "en"));
await ctx.request.post("/api/auth/mock-login",{data:{email:"scan@test.cm",nom:"Scan"}});
await ctx.request.put("/api/me/consentement",{data:{partage_conversations_ia:true,partage_notes:true}});
const liste = await (await ctx.request.get("/api/epreuves?limit=50")).json();
const id = liste.find(e=>e.acces==="gratuit").id;
const FR = /\b(le|la|les|des|du|une?|pour|avec|dans|sur|est|pas|vous|tu|ton|ta|tes|mes|votre|vos|ce|cette|ces|et|ou|nous|aux|au|ne|plus|par|que|qui|aucun|aucune|connecte|ouvrir|épreuves?|corrigés?|abonnements?|accueil|rechercher|fermer|retour)\b/i;
const pages = ["/", "/secondaire/terminale", "/catalogue", "/abonnement", "/calendrier", "/profil", "/connexion", "/nope", `/epreuve/${id}`];
for (const url of pages) {
  const p = await ctx.newPage();
  await p.goto(url); await p.waitForTimeout(2500);
  const lignes = await p.evaluate(() => {
    const out = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; const t = n.textContent.trim(); if (t.length>2 && n.parentElement && !["SCRIPT","STYLE"].includes(n.parentElement.tagName) && getComputedStyle(n.parentElement).display!=="none") out.add(t); }
    document.querySelectorAll("[aria-label],[title],[placeholder]").forEach(e => ["aria-label","title","placeholder"].forEach(a => { const v=e.getAttribute(a); if (v && v.length>2) out.add(`[${a}] ${v}`); }));
    return [...out];
  });
  const fr = lignes.filter(l => FR.test(l));
  console.log(`\n== ${url}  (${fr.length} suspect(s) sur ${lignes.length})`);
  fr.slice(0,40).forEach(l => console.log("  ·", l.slice(0,110)));
  await p.close();
}
await b.close();
