// Tests de bout en bout (navigateur réel). Prérequis : serveur lancé (API + frontend
// compilé) avec AUTH_MODE=mock, puis :
//   E2E_URL=http://localhost:8765 E2E_ADMIN_TOKEN=... [E2E_CHROMIUM=/chemin/chromium] node e2e/e2e.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";

const URL_BASE = process.env.E2E_URL ?? "http://localhost:8765";
const ADMIN = { email: process.env.E2E_ADMIN_EMAIL ?? "admin@example.com", token: process.env.E2E_ADMIN_TOKEN ?? "admin123" };
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/e2e_shots";
fs.mkdirSync(SHOTS, { recursive: true });

const resultats = [];
async function test(nom, fn) {
  try {
    await fn();
    resultats.push([true, nom]);
    console.log("  ✓", nom);
  } catch (e) {
    resultats.push([false, nom, e.message.split("\n")[0]]);
    console.log("  ✗", nom, "\n     →", e.message.split("\n")[0]);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: process.env.E2E_CHROMIUM_ARGS ? process.env.E2E_CHROMIUM_ARGS.split(" ") : [],
});

async function nouveauContexte(options = {}) {
  // serviceWorkers: "block" par défaut — page.route() n'intercepte pas les requêtes servies par un service worker ;
  // seul le scénario PWA l'autorise.
  const ctx = await browser.newContext({ baseURL: URL_BASE, viewport: { width: 1280, height: 900 }, serviceWorkers: "block", ...options });
  return ctx;
}
// Un compte neuf par exécution : les plafonds (5 discussions par épreuve…) ne rendent pas la suite dépendante des précédentes.
const RUN = Date.now().toString(36);
async function connecterEleve(ctx, email = `eleve-${RUN}@test.cm`) {
  const r = await ctx.request.post("/api/auth/mock-login", { data: { email, nom: "Élève E2E" } });
  ok(r.ok(), "mock-login élève : " + r.status());
  // Sans choix de consentement, une modale bloque les clics : on le donne comme un élève.
  const c = await ctx.request.put("/api/me/consentement", { data: { partage_conversations_ia: true, partage_notes: true } });
  ok(c.ok(), "consentement : " + c.status() + " " + (await c.text()).slice(0, 120));
}
// Épreuve publiée et gratuite à 3 sujets avec corrigés (60 lignes chacun) : assez longue pour faire défiler la page,
// assez riche pour avoir tous les outils du lecteur. Indépendante des données des autres tests. Renvoie son id.
async function creerEpreuveRiche(matiere, annee, corps = null, duree = "3h") {
  const adm = await nouveauContexte();
  await connecterAdmin(adm);
  const lignes = (n, mot) => Array.from({ length: n }, (_, i) => `${mot} ${i + 1}.`).join("\n\n");
  const sujets = [1, 2, 3].map((index) => ({ index, contenu_markdown: `# Sujet ${index}\n\n${lignes(60, "Question")}`, corrige_markdown: `Corrigé ${index}\n\n${lignes(60, "Réponse")}` }));
  const contenu = corps === null ? { sujets } : { contenu_markdown: corps }; // `corps` : contenu libre (tests de mise en page)
  const cree = await (await adm.request.post("/api/admin/epreuves", { data: { niveau: "SECONDAIRE", classe: "terminale", evaluation: "BAC", matiere, annee, gratuit: true, filieres: ["C", "D"], duree, ...contenu } })).json();
  await adm.request.post(`/api/admin/epreuves/${cree.id}/publish`);
  await adm.close();
  return cree.id;
}
async function connecterAdmin(ctx) {
  await connecterEleve(ctx, ADMIN.email);
  const r = await ctx.request.post("/api/admin/login", { data: ADMIN });
  ok(r.ok(), "login admin : " + r.status());
}

// ---------------------------------------------------------------- données
const seed = await nouveauContexte();
await connecterAdmin(seed);
// Le serveur sème 3 épreuves au premier démarrage : on ajoute le jeu de test une seule fois.
const matieres = await (await seed.request.get("/api/epreuves/matieres?classe=terminale")).json();
if (!matieres.some((m) => m.matiere === "Physique-Chimie")) {
  const jeux = [["Mathématiques", 2010, 2024], ["Physique-Chimie", 2010, 2019], ["Histoire", 2010, 2019], ["Français", 2015, 2019]];
  for (const [matiere, a, b] of jeux) {
    for (let an = a; an <= b; an++) {
      const r = await seed.request.post("/api/admin/epreuves", {
        data: { niveau: "SECONDAIRE", classe: "terminale", evaluation: "BAC", matiere, annee: String(an), gratuit: an % 5 === 0, filieres: ["C", "D"], duree: "3h",
          contenu_markdown: `# ${matiere} ${an}\n\nQuestion 1 : calculer $x^2 + 2x + 1$ pour x = 3. Exercice sur les fonctions dérivées et les limites.` },
      });
      if (!r.ok()) continue; // doublon avec une épreuve semée par le serveur
      const id = (await r.json()).id;
      ok((await seed.request.post(`/api/admin/epreuves/${id}/publish`)).ok(), "publication");
    }
  }
}
await seed.close();

// ---------------------------------------------------------------- scénarios
console.log("\nCatalogue et recherche");
{
  const ctx = await nouveauContexte();
  await connecterEleve(ctx);
  const page = await ctx.newPage();

  await test("catalogue : tuiles par matière avec compteurs", async () => {
    await page.goto("/secondaire/terminale");
    await page.getByRole("heading", { name: "MATIÈRES" }).waitFor({ timeout: 15000 });
    const tuile = page.getByRole("button", { name: /^Mathématiques\s*\d+ épreuves/ });
    await tuile.waitFor({ timeout: 10000 });
    ok((await page.locator("text=/\\d+ épreuves? ·? ?/").count()) >= 4, "au moins 4 tuiles");
    await page.screenshot({ path: `${SHOTS}/catalogue-tuiles.png` });
  });

  await test("catalogue : une matière → liste groupée par année, retour aux matières", async () => {
    await page.getByRole("button", { name: /^Mathématiques/ }).click();
    await page.locator("h3").first().waitFor({ timeout: 10000 });
    const annees = await page.locator("h3").allTextContents();
    ok(annees.length >= 2 && annees.every((a, i) => i === 0 || a < annees[i - 1]) && /^\d{4}$/.test(annees[0]), "en-têtes d'année (uniques, décroissants) : " + annees.slice(0, 4));
    ok((await page.locator("button[aria-label^='Épreuve de Physique']").count()) === 0, "une seule matière listée");
    await page.screenshot({ path: `${SHOTS}/catalogue-annees.png` });
    await page.getByRole("button", { name: /Toutes les matières/ }).click();
    await page.getByRole("heading", { name: "MATIÈRES" }).waitFor();
  });

  await test("recherche globale insensible aux accents (PostgreSQL + unaccent)", async () => {
    for (const q of ["mathematiques", "MATHÉMATIQUES", "francais"]) {
      const r = await ctx.request.get(`/api/epreuves?q=${encodeURIComponent(q)}&limit=5`);
      const l = await r.json();
      ok(l.length > 0, `aucun résultat pour « ${q} »`);
    }
    await page.goto("/catalogue?q=francais");
    await page.locator("button[aria-label^='Épreuve de Français']").first().waitFor({ timeout: 10000 });
  });

  await test("page 404 réelle (plus de redirection silencieuse)", async () => {
    await page.goto("/cette-page-n-existe-pas");
    await page.getByRole("heading", { name: "Page introuvable" }).waitFor({ timeout: 10000 });
    ok(new URL(page.url()).pathname === "/cette-page-n-existe-pas", "l'URL ne doit pas être redirigée");
  });
  await ctx.close();
}

console.log("\nChargement et réseau lent");
{
  const ctx = await nouveauContexte();
  await connecterEleve(ctx);
  const page = await ctx.newPage();

  await test("squelettes de chargement visibles pendant l'attente de l'API", async () => {
    await page.route("**/api/epreuves/matieres**", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const nav = page.goto("/secondaire/terminale");
    await page.locator(".skeleton").first().waitFor({ timeout: 8000 });
    await nav;
    await page.getByRole("heading", { name: "MATIÈRES" }).waitFor();
    await page.getByRole("button", { name: /^Mathématiques/ }).waitFor({ timeout: 10000 });
    await page.unroute("**/api/epreuves/matieres**");
  });

  await test("bandeau « Le serveur se réveille… » après 3 s, puis disparaît", async () => {
    await page.route("**/api/epreuves/filtres**", async (route) => {
      await new Promise((r) => setTimeout(r, 4500));
      await route.continue();
    });
    await page.goto("/secondaire/terminale");
    await page.getByRole("status").filter({ hasText: "Le serveur se réveille" }).waitFor({ timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/serveur-lent.png` });
    await page.getByRole("status").filter({ hasText: "Le serveur se réveille" }).waitFor({ state: "detached", timeout: 15000 });
    await page.unroute("**/api/epreuves/filtres**");
  });
  await ctx.close();
}

console.log("\nPolices, contraste, mobile");
{
  const ctx = await nouveauContexte();
  const page = await ctx.newPage();
  const reponses = [];
  page.on("response", (r) => reponses.push(r.url()));

  await test("polices hébergées réellement téléchargées (woff2) et appliquées", async () => {
    await page.goto("/");
    // Les @font-face sont lazies : la page peut finir « networkidle » sur ses
    // squelettes de chargement, avant tout peignage du texte serif — et donc
    // avant la MOINDRE demande de police. Attendre le contenu réel (h1),
    // puis demander explicitement le chargement des deux polices du texte
    // (Source Serif 4 = 700 en font-serif-brand, IBM Plex Sans = 400 en
    // corps), sinon un 400 jamais peigné reste « unloaded » à tort.
    await page.locator("h1").first().waitFor({ timeout: 15000 });
    const chargee = await page.evaluate(async () => {
      await document.fonts.load('700 16px "Source Serif 4"');
      await document.fonts.load('400 16px "IBM Plex Sans"');
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`);
    });
    // Le CDN réseau peut servir depuis le cache du service worker (le
    // contrôleur répond sans laisser passer l'évènement `response` de la
    // page) : si le navigateur a la police CHARGÉE, elle a été téléchargée.
    ok(reponses.some((u) => /source-serif-4.*\.woff2$/.test(u)) || chargee.some((f) => f.startsWith("Source Serif 4")), "Source Serif 4 non téléchargée");
    ok(reponses.some((u) => /ibm-plex-sans.*\.woff2$/.test(u)) || chargee.some((f) => f.startsWith("IBM Plex Sans")), "IBM Plex Sans non téléchargée");
    ok(chargee.some((f) => /Source Serif 4/.test(f)) && chargee.some((f) => /IBM Plex Sans/.test(f)), "polices non chargées : " + chargee);
  });

  await test("assets Vite servis en cache immuable", async () => {
    const asset = reponses.find((u) => /\/assets\/index-.*\.js$/.test(u));
    ok(asset, "bundle d'entrée introuvable");
    const r = await ctx.request.get(asset);
    ok(/immutable/.test(r.headers()["cache-control"] ?? ""), "Cache-Control : " + r.headers()["cache-control"]);
  });

  await test("barre d'onglets : visible sur mobile, absente sur ordinateur", async () => {
    const mobile = await nouveauContexte({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    const pm = await mobile.newPage();
    await pm.goto("/");
    await pm.getByRole("navigation", { name: "Navigation principale" }).waitFor({ timeout: 10000 });
    await pm.screenshot({ path: `${SHOTS}/mobile-accueil.png` });
    await pm.getByRole("navigation", { name: "Navigation principale" }).getByRole("link", { name: "Catalogue" }).click();
    await pm.waitForURL("**/catalogue**");
    await mobile.close();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    ok(!(await page.getByRole("navigation", { name: "Navigation principale" }).isVisible()), "visible sur ordinateur");
  });

  await test("contraste du doré de texte ≥ 4,5:1 (WCAG AA)", async () => {
    await page.goto("/");
    const c = await page.evaluate(() => {
      const el = document.createElement("span");
      el.className = "text-highlight-text";
      el.textContent = "x";
      document.body.append(el);
      const fg = getComputedStyle(el).color;
      const bg = getComputedStyle(document.body).backgroundColor;
      el.remove();
      return { fg, bg };
    });
    const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [l1, l2] = [lum(rgb(c.fg)), lum(rgb(c.bg))].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    ok(ratio >= 4.5, `contraste ${ratio.toFixed(2)} (${c.fg} sur ${c.bg})`);
  });
  await ctx.close();
}

console.log("\nLecteur et assistant élève");
{
  const ctx = await nouveauContexte();
  await connecterEleve(ctx);
  const page = await ctx.newPage();
  const liste = await (await ctx.request.get("/api/epreuves?q=mathematiques&limit=50")).json();
  // Une épreuve GRATUITE avec notre contenu de test (les payantes exigent un abonnement).
  const epreuveId = liste.find((e) => e.acces === "gratuit" && /Exercice sur les fonctions/.test(e.extrait ?? "") ) ?.id ?? liste.find((e) => e.acces === "gratuit").id;

  await test("lecteur : chargement différé (skeleton) puis contenu et formule KaTeX, sans avertissement KaTeX", async () => {
    const avertissements = [];
    page.on("console", (m) => { if (["warning", "error"].includes(m.type()) && /katex|latex/i.test(m.text())) avertissements.push(m.text().slice(0, 120)); });
    await page.goto(`/epreuve/${epreuveId}`);
    await page.locator(".katex").first().waitFor({ timeout: 15000 });
    ok(avertissements.length === 0, "avertissements KaTeX : " + avertissements.join(" | "));
    const version = await page.evaluate(() => getComputedStyle(document.querySelector(".katex")).fontSize);
    ok(parseFloat(version) > 0, "formule non rendue");
    await page.screenshot({ path: `${SHOTS}/lecteur.png` });
  });

  await test("taille du texte : A+ agrandit et le choix est mémorisé", async () => {
    const zone = page.locator("div[style*='zoom']").first();
    const avant = await zone.evaluate((e) => getComputedStyle(e).zoom);
    await page.getByRole("button", { name: "Agrandir le texte" }).click();
    const apres = await zone.evaluate((e) => getComputedStyle(e).zoom);
    ok(Number(apres) > Number(avant), `zoom ${avant} → ${apres}`);
    await page.reload();
    await page.locator(".katex").first().waitFor({ timeout: 15000 });
    const apresReload = await page.locator("div[style*='zoom']").first().evaluate((e) => getComputedStyle(e).zoom);
    ok(apresReload === apres, `non mémorisé : ${apresReload} ≠ ${apres}`);
  });

  await test("lecture paginée : bascule, navigation page suivante/précédente et préférence mémorisée", async () => {
    // Épreuve riche dédiée : plusieurs pages garanties, indépendante du contenu des autres scénarios. Année PASSÉE :
    // une année future passerait devant les épreuves à formules dans les recherches triées par année (autres scénarios).
    const riche = await creerEpreuveRiche("Mathématiques", "1998");
    await page.goto(`/epreuve/${riche}`);
    await page.locator(".prose-exam").first().waitFor({ timeout: 15000 });
    const statut = page.locator("[data-testid=page-status]");
    await page.getByRole("button", { name: "Lecture paginée" }).click();
    await page.locator("[data-testid=feuille]").first().waitFor({ timeout: 15000 });
    await statut.waitFor({ timeout: 15000 });
    const premier = (await statut.textContent())?.trim() ?? "";
    const m = premier.match(/^Page 1 \/ (\d+)$/);
    ok(m, `statut initial inattendu : ${premier}`);
    const total = Number(m[1]);
    ok(total > 1, `le contenu n'est pas paginé : ${premier}`);
    // La feuille paginée ne doit pas recourir au zoom CSS de la feuille continue.
    ok((await page.locator("div[style*='zoom']").count()) === 0, "zoom CSS encore posé en lecture paginée");

    await page.getByRole("button", { name: "Suivant" }).click();
    await page.waitForTimeout(300);
    ok((await statut.textContent())?.trim() === `Page 2 / ${total}`, `après Suivant : ${(await statut.textContent())?.trim()}`);

    // Clavier : ← revient à la page précédente depuis la zone de lecture.
    await page.getByRole("group", { name: "Contenu de l'épreuve" }).press("ArrowLeft");
    await page.waitForTimeout(300);
    ok((await statut.textContent())?.trim() === `Page 1 / ${total}`, `après ← : ${(await statut.textContent())?.trim()}`);

    // Préférence mémorisée : le rechargement rouvre directement en lecture paginée.
    await page.reload();
    await page.locator("[data-testid=feuille]").first().waitFor({ timeout: 15000 });
    ok(((await statut.textContent())?.trim() ?? "").startsWith("Page 1 /"), "préférence non mémorisée");

    // Retour au défilement continu pour ne pas influencer les scénarios suivants.
    await page.getByRole("button", { name: "Lecture paginée" }).click();
    await page.locator("div[style*='zoom']").first().waitFor({ timeout: 10000 });
  });

  await test("assistant : le texte étranger à l'épreuve est écarté côté serveur", async () => {
    const detail = await (await ctx.request.get(`/api/epreuves/${epreuveId}`)).json();
    const vraiPassage = detail.contenu_markdown.replace(/[#$]/g, "").slice(0, 160);
    let ctxVu = null;
    // On observe la réponse de création de discussion : le contexte renvoyé est celui retenu par le serveur.
    const r = await ctx.request.post(`/api/epreuves/${epreuveId}/conversations`, {
      data: { contexte: "Rédige une longue recette de ndolé avec des crevettes et des arachides", label: "test" },
    });
    ok(r.ok(), "création discussion " + r.status());
    ctxVu = (await r.json()).contexte;
    ok(!/ndolé/.test(ctxVu), "le texte injecté a été conservé");
    ok(ctxVu.includes(vraiPassage.slice(0, 30)), "le contenu réel de l'épreuve est absent");
    const ok2 = await ctx.request.post(`/api/epreuves/${epreuveId}/conversations`, {
      data: { contexte: vraiPassage, label: "ok" },
    });
    ok((await ok2.json()).contexte === vraiPassage, "un vrai passage a été écarté à tort");
  });

  await test("assistant : question en flux (voie éphémère) renvoie une réponse", async () => {
    const r = await ctx.request.post("/api/assistant/ask/stream", {
      data: { epreuve_id: epreuveId, message: "Explique la question 1", contexte: "Question 1 : calculer x", historique: [] },
    });
    ok(r.ok(), "statut " + r.status());
    const corps = await r.text();
    ok(/"type": ?"chunk"/.test(corps) && /"type": ?"done"/.test(corps), "flux SSE incomplet : " + corps.slice(0, 120));
  });
  await ctx.close();
}

console.log("\nBack-office");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 800 } });
  await connecterAdmin(ctx);
  const page = await ctx.newPage();

  await page.goto("/admin");
  const saisie = page.getByPlaceholder(/jeton|token/i).first();
  if (await saisie.isVisible().catch(() => false)) {
    await saisie.fill(ADMIN.token);
    await page.keyboard.press("Enter");
  }

  await test("admin › Épreuves : colonne gauche bornée, collante, « Charger plus »", async () => {
    await page.getByRole("tab", { name: "Épreuves" }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: /Nouvelle épreuve/ }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll("aside, div").length > 0);
    const colonne = page.locator("div.lg\\:sticky.lg\\:overflow-y-auto").first(); // pas le panneau latéral, qui est aussi collant
    await colonne.waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /Charger plus/ }).waitFor({ timeout: 10000 });
    const haut = await colonne.evaluate((e) => ({ h: e.getBoundingClientRect().height, sh: e.scrollHeight, vh: window.innerHeight }));
    ok(haut.h <= haut.vh, `colonne ${haut.h}px > fenêtre ${haut.vh}px`);
    ok(haut.sh > haut.h, "la liste ne défile pas à l'intérieur de la colonne");
    await page.screenshot({ path: `${SHOTS}/admin-epreuves.png` });
    const n1 = await colonne.locator("button[aria-current]").count();
    await page.getByRole("button", { name: /Charger plus/ }).click();
    await page.waitForFunction((n) => document.querySelectorAll("button[aria-current]").length > n, n1, { timeout: 10000 });
    await page.mouse.wheel(0, 3000);
    const pos = await colonne.evaluate((e) => e.getBoundingClientRect().top);
    ok(pos >= 0 && pos < 200, `colonne non collante (top=${pos})`);
  });

  await test("admin › Formules : créer, modifier, activer puis supprimer", async () => {
    await page.getByRole("tab", { name: "Formules" }).click();
    await page.getByText("Les formules actives sont proposées").waitFor({ timeout: 10000 });
    const avant = await page.getByLabel("Libellé (FR)").count();
    await page.getByRole("button", { name: "Matière (toutes années)" }).last().click(); // boutons de création en bas de page
    await page.waitForFunction((n) => document.querySelectorAll("input[aria-label='Libellé (FR)']").length > n, avant);
    const dernier = page.getByLabel("Libellé (FR)").last(); // une nouvelle formule se place en dernier
    ok((await dernier.inputValue()) === "Matière (toutes années)", "la nouvelle formule n'est pas en dernière position : " + (await dernier.inputValue()));
    await dernier.fill("Matière 3 mois");
    await page.getByLabel("Prix (FCFA)").last().fill("1200");
    await page.getByLabel("Durée (jours)").last().fill("90");
    await page.getByLabel("Active").last().check();
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await page.getByText("Formule enregistrée.").waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/admin-formules.png` });
    const pricing = await (await ctx.request.get("/api/pricing")).json();
    ok(pricing.plans.some((p) => p.libelle === "Matière 3 mois" && p.prix === 1200 && p.duree_jours === 90), "formule absente de /api/pricing");
    await page.getByRole("button", { name: "Supprimer Matière 3 mois" }).click();
    await page.getByRole("button", { name: /Supprimer|Confirmer/ }).last().click();
    await page.waitForFunction(() => ![...document.querySelectorAll("input[aria-label='Libellé (FR)']")].some((i) => i.value === "Matière 3 mois"));
  });

  await test("page Abonnement : les formules viennent de la base (prix modifié visible)", async () => {
    const plans = (await (await ctx.request.get("/api/admin/plans")).json()).plans;
    const p = plans.find((x) => x.scope === "epreuve" && x.actif);
    await ctx.request.patch(`/api/admin/plans/${p.id}`, { data: { prix: 650 } });
    await page.goto("/abonnement");
    await page.getByText("650 FCFA").first().waitFor({ timeout: 10000 });
    await ctx.request.patch(`/api/admin/plans/${p.id}`, { data: { prix: p.prix } });
  });
  await ctx.close();
}

console.log("\nCalendrier, examen blanc, révisions, PDF");
{
  const admin = await nouveauContexte({ viewport: { width: 1366, height: 800 } });
  await connecterAdmin(admin);
  const ctx = await nouveauContexte();
  await connecterEleve(ctx, `lot5-${RUN}@test.cm`);
  const page = await ctx.newPage();
  const suffixe = Date.now().toString(36);
  const titreExamen = `Probatoire — session ${suffixe}`;
  // Date LOCALE (A-M-J) et non `toISOString()` (date UTC) : `joursAvant`
  // compte en jours calendaires locaux — une date UTC renseignée le soir
  // (UTC déjà passé minuit) affiche J−(n−1) et le test échoue.
  const dans = (jours) => {
    const d = new Date(Date.now() + jours * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  await test("admin › Calendrier : ajouter un examen, il apparaît sur la page publique et en compte à rebours", async () => {
    for (const ev of await (await admin.request.get("/api/admin/evenements")).json()) await admin.request.delete(`/api/admin/evenements/${ev.id}`);
    const pa = await admin.newPage();
    await pa.goto("/admin");
    await pa.getByRole("tab", { name: "Calendrier" }).click();
    await pa.getByLabel("Titre", { exact: true }).filter({ visible: true }).fill(titreExamen);
    await pa.getByLabel("Évaluation", { exact: true }).filter({ visible: true }).fill("PROBATOIRE");
    await pa.getByLabel("Date de début").fill(dans(30));
    await pa.getByRole("button", { name: "Ajouter l'événement" }).click();
    await pa.getByText("Événement ajouté.").waitFor({ timeout: 10000 });
    await pa.screenshot({ path: `${SHOTS}/admin-calendrier.png` });
    await page.goto("/calendrier");
    await page.getByText(titreExamen).first().waitFor({ timeout: 10000 });
    await page.getByText("J−30").first().waitFor();
    await page.screenshot({ path: `${SHOTS}/calendrier.png` });
    await page.goto("/");
    await page.getByRole("link", { name: new RegExp(titreExamen) }).waitFor({ timeout: 10000 });
    await page.getByText("J−30").waitFor();
  });

  // Épreuve gratuite AVEC corrigé : indispensable pour prouver que l'examen blanc le masque vraiment.
  const adm = admin.request;
  const cree = await (await adm.post("/api/admin/epreuves", { data: {
    niveau: "SECONDAIRE", classe: "terminale", evaluation: "BAC", matiere: "Mathématiques", annee: "2031", gratuit: true, filieres: ["C"], duree: "3h",
    contenu_markdown: "# Sujet 2031\n\nQuestion 1 : résoudre $x^2 = 4$.", corrige_markdown: "# Corrigé 2031\n\nSOLUTION-SECRETE-XYZ : x = 2 ou x = -2." } })).json();
  await adm.post(`/api/admin/epreuves/${cree.id}/publish`);
  const gratuite = { id: cree.id };

  await test("examen blanc : le corrigé et l'assistant disparaissent, la note est enregistrée", async () => {
    await page.goto(`/epreuve/${gratuite.id}`);
    await page.locator(".katex").first().waitFor({ timeout: 15000 });
    ok((await page.getByRole("tab", { name: "Corrigé" }).count()) === 1, "précondition : l'onglet Corrigé doit exister avant l'examen");
    ok((await page.getByRole("button", { name: "Ouvrir Tuteur IA Prep" }).count()) >= 1, "précondition : l'assistant doit être proposé avant l'examen");
    await page.getByRole("button", { name: /Examen blanc/ }).click();
    await page.getByRole("timer").waitFor();
    ok((await page.getByRole("tab", { name: "Corrigé" }).count()) === 0, "l'onglet Corrigé est encore visible");
    ok((await page.getByRole("button", { name: "Ouvrir Tuteur IA Prep" }).count()) === 0, "l'assistant est encore proposé");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("c");
    await page.waitForTimeout(300);
    ok((await page.getByText("SOLUTION-SECRETE-XYZ").count()) === 0, "le raccourci C a révélé le corrigé pendant l'examen");
    await page.screenshot({ path: `${SHOTS}/examen-blanc.png` });
    await page.getByRole("button", { name: "Terminer" }).click();
    await page.getByLabel("Ma note sur 20").fill("22");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await page.getByText("Entre une note entre 0 et 20.").waitFor({ timeout: 5000 });
    await page.getByLabel("Ma note sur 20").fill("7,5");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await page.getByText("Essai enregistré.").waitFor({ timeout: 10000 });
    await page.getByRole("tab", { name: "Corrigé" }).click(); // l'examen est fini : le corrigé redevient accessible
    await page.getByText("SOLUTION-SECRETE-XYZ").waitFor({ timeout: 5000 });
    const h = await (await ctx.request.get("/api/me/essais")).json();
    ok(h.essais.some((e) => e.note === 7.5 && e.duree_s !== null), "essai absent de l'historique");
  });

  await test("« À revoir » → la révision apparaît à l'accueil quand l'échéance est passée", async () => {
    await page.getByRole("button", { name: /À revoir/ }).click();
    await page.getByText("Ajoutée à tes révisions.").waitFor({ timeout: 10000 });
    // échéance non atteinte : rien à l'accueil
    await page.goto("/");
    await page.getByRole("heading", { name: "À REVOIR AUJOURD'HUI" }).waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    ok((await page.getByRole("heading", { name: "À REVOIR AUJOURD'HUI" }).count()) === 0, "révision affichée trop tôt");
  });

  await test("export PDF : zone d'impression visible à l'impression seulement (sujet + corrigé)", async () => {
    await page.goto(`/epreuve/${gratuite.id}`);
    await page.locator(".katex").first().waitFor({ timeout: 15000 });
    await page.evaluate(() => { window.print = () => { window.__imprime = true; }; });
    await page.getByRole("button", { name: "PDF" }).click();
    const options = await page.getByRole("menuitem").allTextContents();
    ok(options.length >= 1, "menu PDF vide");
    await page.getByRole("menuitem", { name: options[options.length - 1] }).click();
    await page.waitForFunction(() => window.__imprime === true, null, { timeout: 5000 });
    ok((await page.locator(".print-zone").isVisible()) === false, "zone d'impression visible à l'écran");
    await page.emulateMedia({ media: "print" });
    ok(await page.locator(".print-zone").isVisible(), "zone d'impression absente en mode impression");
    ok(!(await page.locator("#root").isVisible()), "l'application reste visible à l'impression");
    ok(new RegExp(`lot5-${RUN}@test.cm`).test(await page.locator(".print-pied").innerText()), "identité absente du pied de page");
    const pdf = await page.pdf({ format: "A4" });
    ok(pdf.length > 5000 && pdf.subarray(0, 4).toString() === "%PDF", "PDF invalide");
    fs.writeFileSync(`${SHOTS}/sujet.pdf`, pdf);
    await page.emulateMedia({ media: "screen" });
  });
  await admin.close();
  await ctx.close();
}

console.log("\nTraduction FR/EN");
{
  const ctx = await nouveauContexte();
  await connecterEleve(ctx, `i18n-${RUN}@test.cm`);
  const page = await ctx.newPage();
  const en = JSON.parse(fs.readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8"));
  const T = (cle) => en[cle] ?? cle;
  const CLES_FR = new Set(Object.keys(en).filter((k) => en[k] !== k)); // un texte égal à une clé française traduite n'a pas été traduit
  // Résidu = clé française telle quelle, mot français courant, ou lettre accentuée (l'interface anglaise n'en a pas).
  // Exclus : contenu des épreuves et conversations (français par nature), noms de matières (données du référentiel).
  const FR = /\b(le|la|les|des|du|une?|pour|avec|dans|sur|est|pas|tu|ton|ta|tes|mes|votre|ce|cette|ces|et|ou|aux|aucune?|tous|toutes|sans|ouvrir|connecte|retour|accueil|abonnements?|épreuves?|corrigés?|rechercher|fermer|profil|publiée?s?|gratuites?|séries?|matières?|année|niveaux?|secondaire|primaire|voir|examen|blanc|sujets?|officiel|enregistr\w+)\b|épreuve\(s\)|publiée\(s\)/i;
  const ACCENT = /[àâçéèêëîïôûùüÀÂÇÉÈÊËÎÏÔÛÙÜ]/;
  const DONNEES = /^(Élève E2E.*|ÉE|1ère|Copies & Corrigés.*)$/;
  let matieres = /$^/;
  const residu = (l) => {
    if (DONNEES.test(l)) return false;
    const reste = l.replace(matieres, "").replaceAll("Copies & Corrigés", "").trim(); // le nom de la marque contient un « é »
    return !!reste && (CLES_FR.has(reste) || FR.test(reste) || ACCENT.test(reste));
  };
  const lire = (pg) => pg.evaluate(() => {
    const out = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode, t = n.textContent.trim(), p = n.parentElement;
      if (t.length > 2 && p && !p.closest(".markdown, .prose-exam, [role=log], script, style") && getComputedStyle(p).display !== "none") out.add(t);
    }
    document.querySelectorAll("[aria-label],[title],[placeholder],[alt]").forEach((e) => ["aria-label", "title", "placeholder", "alt"].forEach((a) => { const v = e.getAttribute(a); if (v && v.length > 2) out.add(v); }));
    return [...out];
  });
  const balayer = async (pg, etat, residus) => {
    await pg.waitForTimeout(1500);
    for (const l of await lire(pg)) if (residu(l)) residus.push(`${etat} → ${l.slice(0, 70)}`);
  };
  const enAnglais = async (options = {}) => {
    const c = await nouveauContexte(options);
    await c.addInitScript(() => localStorage.setItem("bacprep-lang", "en"));
    return c;
  };
  let liste = [];
  let gratuit;

  await test("sélecteur de langue : bascule en anglais, mémorise le choix, revient en français", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Home", exact: true }).waitFor({ state: "detached", timeout: 500 }).catch(() => {});
    await page.getByRole("link", { name: "Accueil" }).first().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "en", exact: true }).click();
    await page.getByRole("link", { name: "Home" }).first().waitFor({ timeout: 10000 });
    ok((await page.locator("html").getAttribute("lang")) === "en", "<html lang> non mis à jour");
    await page.reload();
    await page.getByRole("link", { name: "Home" }).first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/accueil-en.png` });
    await page.getByRole("button", { name: "fr", exact: true }).click();
    await page.getByRole("link", { name: "Accueil" }).first().waitFor({ timeout: 10000 });
  });

  await test("anglais : aucun texte d'interface français sur les pages principales", async () => {
    await ctx.addInitScript(() => localStorage.setItem("bacprep-lang", "en"));
    liste = await (await ctx.request.get("/api/epreuves?limit=50")).json();
    gratuit = liste.find((e) => e.acces === "gratuit").id;
    const noms = [...new Set(liste.map((e) => e.matiere))].map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    matieres = new RegExp(noms.join("|"), "gi");
    const residus = [];
    for (const url of ["/", "/secondaire/terminale", "/catalogue", "/abonnement", "/calendrier", "/profil", "/connexion", "/introuvable", "/aide", "/a-propos", `/epreuve/${gratuit}`]) {
      await page.goto(url);
      await balayer(page, url, residus);
    }
    ok(residus.length === 0, "textes français en mode anglais : " + residus.slice(0, 6).join(" | "));
  });

  await test("anglais : formules d'abonnement affichées avec libellé et description anglais", async () => {
    // Indépendant des formules semées : on lit celles que l'API sert réellement et on exige leur libellé anglais.
    const { plans } = await (await ctx.request.get("/api/pricing")).json();
    const anglaises = plans.filter((p) => p.libelle_en && p.libelle_en !== p.libelle);
    ok(anglaises.length >= 1, "aucune formule active n'a de libellé anglais");
    await page.goto("/abonnement");
    for (const p of anglaises.slice(0, 3)) await page.getByText(p.libelle_en, { exact: true }).first().waitFor({ timeout: 10000 });
    if (anglaises[0].description_en) await page.getByText(anglaises[0].description_en, { exact: true }).first().waitFor({ timeout: 5000 });
  });

  await test("anglais : profil d'un abonné — abonnements, notes, activité, confidentialité (états réellement atteints)", async () => {
    const payante = liste.find((e) => e.acces !== "gratuit");
    ok(payante, "aucune épreuve payante dans les données de test");
    const achat = await ctx.request.post("/api/subscriptions/checkout", { data: { scope: "epreuve", epreuve_id: payante.id, provider: "orange" } });
    ok(achat.ok(), "checkout : " + achat.status());
    await ctx.request.post("/api/payments/simulate-webhook", { data: { reference_agregateur: (await achat.json()).reference_agregateur } });
    await ctx.request.post(`/api/epreuves/${gratuit}/notes`, { data: { contenu: "ma note de test" } });
    const residus = [];
    await page.goto("/profil");
    for (const [onglet, preuve] of [
      ["Abonnements", T("Épreuve précise")],
      ["Mes notes", "ma note de test"],
      ["Activité", T("Connexion à ton compte (ordinateur)")],
      ["Confidentialité", T("Tu décides de ce qui est conservé sur nos serveurs. Un refus est effectif immédiatement ; tu peux changer d'avis ici à tout moment.")],
    ]) {
      await page.getByRole("tab", { name: T(onglet) }).click();
      await page.getByText(preuve).first().waitFor({ timeout: 10000 }); // l'état est atteint : le contrôle ne peut pas passer à vide
      await balayer(page, `profil › ${T(onglet)}`, residus);
    }
    ok(residus.length === 0, "textes français : " + residus.slice(0, 6).join(" | "));
  });

  await test("anglais : lecteur (assistant, signalement), visiteur, consentement, erreurs de chargement", async () => {
    const residus = [];
    await page.goto(`/epreuve/${gratuit}`);
    await page.getByRole("button", { name: T("Ouvrir Tuteur IA Prep") }).click();
    await page.getByLabel(T("Question à Tuteur IA Prep")).waitFor({ timeout: 10000 });
    await balayer(page, "assistant", residus);
    // Compté AVANT l'envoi : le panneau désactive le champ tant que la
    // discussion n'est pas prête (le clic attend donc son activation).
    const avantChat = await page.locator(".prose-chat").count();
    await page.getByLabel(T("Question à Tuteur IA Prep")).fill("Explain question 1");
    await page.getByRole("button", { name: T("Envoyer") }).click();
    // La réponse est celle du LLM RÉEL si une clé est configurée, sinon la
    // réponse simulée [Mode démonstration] : ne pas attendre un texte donné.
    // 2 nouveaux blocs .prose-chat (question + réponse) prouvent l'échange.
    await page.waitForFunction((n) => document.querySelectorAll(".prose-chat").length >= n + 2, avantChat, { timeout: 20000 });
    await balayer(page, "assistant › réponse", residus);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: T("Signaler un problème sur cette épreuve") }).click();
    await page.getByRole("dialog", { name: T("Signaler un problème") }).waitFor({ timeout: 5000 });
    await balayer(page, "signalement", residus);
    await page.keyboard.press("Escape");

    const visiteur = await enAnglais();
    const pv = await visiteur.newPage();
    await pv.goto(`/epreuve/${gratuit}`);
    await pv.getByText(T("Consultation libre en mode visiteur — les fonctionnalités du compte sont visibles mais verrouillées :")).waitFor({ timeout: 10000 });
    await balayer(pv, "visiteur", residus);

    const neuf = await enAnglais();
    ok((await neuf.request.post("/api/auth/mock-login", { data: { email: `cons-${RUN}@test.cm`, nom: "Élève E2E" } })).ok(), "mock-login sans consentement"); // aucun choix enregistré : la modale s'affiche
    const pn = await neuf.newPage();
    await pn.goto("/");
    await pn.getByText(T("Pour fonctionner, Tuteur IA Prep et tes notes doivent être enregistrés sur nos serveurs. Tu décides quoi, et tu peux changer d'avis à tout moment dans ton profil. Sans ton accord, la fonctionnalité concernée reste utilisable mais rien n'est conservé après la session.")).waitFor({ timeout: 10000 });
    await balayer(pn, "consentement", residus);

    const reseau = await enAnglais();
    await connecterEleve(reseau, `err-${RUN}@test.cm`);
    const pr = await reseau.newPage();
    await pr.route("**/api/epreuves?*", (r) => r.abort());
    await pr.goto("/catalogue?q=math"); // mode liste : le mode tuiles n'appelle pas cette route
    await pr.getByText(T("Le catalogue n'a pas pu être chargé.")).waitFor({ timeout: 15000 });
    await balayer(pr, "catalogue en erreur", residus);
    await pr.route("**/api/pricing*", (r) => r.abort());
    await pr.goto("/abonnement");
    await pr.getByText(T("La grille tarifaire n'a pas pu être chargée.")).waitFor({ timeout: 15000 });
    await balayer(pr, "abonnement en erreur", residus);
    for (const c of [visiteur, neuf, reseau]) await c.close();
    await page.goto("/");
    await page.getByRole("button", { name: T("Inviter des amis") }).first().click();
    await page.getByRole("dialog", { name: T("Inviter des amis") }).waitFor({ timeout: 5000 });
    await balayer(page, "invitation", residus);
    await page.keyboard.press("Escape");
    ok(residus.length === 0, "textes français : " + residus.slice(0, 6).join(" | "));
  });

  await test("anglais : messages du serveur traduits — signalement en double, session fermée, bienvenue", async () => {
    // 1. Signalement en double : le détail 409 est un texte français du serveur.
    await page.goto(`/epreuve/${gratuit}`);
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: T("Signaler un problème sur cette épreuve") }).click();
      const d = page.getByRole("dialog", { name: T("Signaler un problème") });
      await d.getByRole("button", { name: T("Erreur dans l'énoncé") }).click();
      await d.getByRole("button", { name: T("Envoyer") }).click();
      await page.getByText(i === 0 ? T("Signalement envoyé — merci, l'équipe va vérifier le contenu.") : T("Tu as déjà signalé ce problème sur cette épreuve — il est en attente de traitement.")).waitFor({ timeout: 10000 });
    }
    // 2. Session fermée : message envoyé par le serveur dans l'évènement WebSocket.
    const email = `kick-${RUN}@test.cm`;
    const a = await enAnglais();
    await connecterEleve(a, email);
    const pa = await a.newPage();
    const ouvert = pa.waitForEvent("websocket", { predicate: (w) => w.url().includes("/ws/session"), timeout: 15000 });
    await pa.goto("/");
    await ouvert; // sans socket ouvert, la seconde connexion invaliderait la session sans message
    const b = await enAnglais();
    await connecterEleve(b, email); // seconde session : ferme la première
    await pa.getByText(T("Votre session a été fermée car vous vous êtes connecté ailleurs.")).waitFor({ timeout: 20000 });
    // 3. Toast de bienvenue après connexion par l'interface.
    const c = await enAnglais();
    const pc = await c.newPage();
    await pc.goto("/connexion");
    await pc.getByPlaceholder(T("ex. Franck Albert")).fill("Marie");
    await pc.getByPlaceholder(T("ex. franck.albert@exemple.com")).fill(`bienvenue-${RUN}@test.cm`);
    await pc.getByRole("button", { name: T("Se connecter") }).click();
    await pc.getByText("Welcome, Marie!").waitFor({ timeout: 10000 });
    for (const x of [a, b, c]) await x.close();
  });
  await ctx.close();
}

console.log("\nPWA et lecture hors-ligne");
{
  const admin = await nouveauContexte();
  await connecterAdmin(admin);
  const ctx = await nouveauContexte({ serviceWorkers: "allow" });
  await connecterEleve(ctx, `pwa-${RUN}@test.cm`);
  const page = await ctx.newPage();

  // Épreuve gratuite AVEC image : le texte et l'image doivent rester lisibles sans réseau.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const cree = await (await admin.request.post("/api/admin/epreuves", { data: {
    niveau: "SECONDAIRE", classe: "terminale", evaluation: "BAC", matiere: "Chimie", annee: "2032", gratuit: true, filieres: ["C"], duree: "2h",
    contenu_markdown: "# Chimie 2032\n\nTEXTE-HORS-LIGNE-ABC : dosage d'un acide." } })).json();
  const img = await (await admin.request.post(`/api/admin/epreuves/${cree.id}/images`, { multipart: { cible: "sujet", file: { name: "schema.png", mimeType: "image/png", buffer: PNG } } })).json();
  ok(img.url, "envoi d'image refusé : " + JSON.stringify(img));
  await admin.request.put(`/api/admin/epreuves/${cree.id}`, { data: { niveau: "SECONDAIRE", classe: "terminale", evaluation: "BAC", matiere: "Chimie", annee: "2032", gratuit: true, filieres: ["C"], duree: "2h",
    contenu_markdown: `# Chimie 2032\n\nTEXTE-HORS-LIGNE-ABC : dosage d'un acide.\n\n![Schéma du dosage](${img.url})` } });
  await admin.request.post(`/api/admin/epreuves/${cree.id}/publish`);

  await test("manifeste installable, icônes et service worker servis correctement", async () => {
    const m = await ctx.request.get("/manifest.webmanifest");
    ok(m.ok(), "manifeste : " + m.status());
    const man = await m.json();
    ok(man.display === "standalone" && man.start_url === "/" && man.icons.length >= 3, "manifeste incomplet");
    ok(man.icons.some((i) => i.purpose === "maskable"), "pas d'icône maskable");
    for (const i of man.icons) ok((await ctx.request.get(i.src)).ok(), "icône absente : " + i.src);
    const sw = await ctx.request.get("/sw.js");
    ok(sw.ok() && /javascript/.test(sw.headers()["content-type"]), "sw.js : " + sw.headers()["content-type"]);
    ok(/no-cache/.test(sw.headers()["cache-control"] ?? ""), "sw.js doit être revalidé : " + sw.headers()["cache-control"]);
    const html = await (await ctx.request.get("/")).text();
    ok(/<meta name="description"/.test(html) && /og:title/.test(html) && /rel="manifest"/.test(html), "balises description / Open Graph / manifest absentes");
  });

  await test("service worker installé et actif, coque de l'application précachée", async () => {
    await page.goto("/");
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active), null, { timeout: 20000 });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    const noms = await page.evaluate(() => caches.keys());
    ok(noms.some((n) => /precache/.test(n)), "pas de précache : " + noms);
    const admin = await page.evaluate(async () => (await (await caches.open((await caches.keys()).find((n) => /precache/.test(n)))).keys()).map((r) => r.url).filter((u) => /AdminPage/.test(u)));
    ok(admin.length === 0, "le back-office ne doit pas être précaché : " + admin);
  });

  await test("service worker : la doc OpenAPI (/docs) n'est pas avalée par la coque de l'application", async () => {
    // Régression corrigée : le service worker répondait index.html (« Page introuvable ») à /docs.
    await page.goto("/docs");
    ok(/swagger/i.test(await page.title()), "la doc OpenAPI n'est pas servie : titre = " + (await page.title()));
    ok((await page.getByText("Page introuvable").count()) === 0, "la page 404 de l'application a remplacé la doc");
  });

  await test("téléchargement hors-ligne : épreuve + image mises de côté, copie signalée", async () => {
    await page.goto(`/epreuve/${cree.id}`);
    await page.getByText("TEXTE-HORS-LIGNE-ABC").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: /^Hors-ligne$/ }).click();
    await page.getByText("Épreuve disponible hors-ligne.").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Hors-ligne ✓" }).waitFor();
    const etat = await page.evaluate(async () => ({
      detail: !!(await (await caches.open("epreuves")).match(location.origin + "/api/epreuves/" + location.pathname.split("/").pop())),
      images: (await (await caches.open("epreuves-images")).keys()).length,
      liste: JSON.parse(localStorage.getItem("bacprep-hors-ligne") ?? "[]").length,
    }));
    ok(etat.detail && etat.images >= 1 && etat.liste === 1, "copie locale incomplète : " + JSON.stringify(etat));
  });

  await test("SANS RÉSEAU : l'épreuve s'ouvre depuis le cache, texte et image compris", async () => {
    await ctx.setOffline(true);
    await page.goto(`/epreuve/${cree.id}`);
    await page.getByText("TEXTE-HORS-LIGNE-ABC").waitFor({ timeout: 20000 });
    await page.getByRole("status").filter({ hasText: "hors-ligne" }).waitFor({ timeout: 5000 });
    const img = page.getByRole("img", { name: "Schéma du dosage" });
    await img.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => [...document.images].some((i) => i.alt === "Schéma du dosage" && i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/hors-ligne.png` });
  });

  await test("SANS RÉSEAU : une épreuve jamais téléchargée n'apparaît pas, l'accueil liste les copies", async () => {
    await page.goto("/");
    await page.getByRole("heading", { name: "DISPONIBLES HORS-LIGNE" }).waitFor({ timeout: 15000 });
    await page.getByRole("link", { name: /Chimie/ }).waitFor();
    await ctx.setOffline(false);
  });

  await test("déconnexion : copies locales et caches purgés (appareil partagé)", async () => {
    await page.goto(`/epreuve/${cree.id}`);
    await page.getByText("TEXTE-HORS-LIGNE-ABC").waitFor({ timeout: 15000 });
    await page.goto("/profil");
    await page.getByRole("button", { name: /Se déconnecter|Sign out/ }).first().click();
    await page.getByText("Déconnexion réussie.").waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const apres = await page.evaluate(async () => ({ liste: localStorage.getItem("bacprep-hors-ligne"), caches: (await caches.keys()).filter((n) => ["epreuves", "epreuves-images", "session"].includes(n)) }));
    ok(apres.liste === null && apres.caches.length === 0, "copies non purgées : " + JSON.stringify(apres));
  });
  await admin.close();
  await ctx.close();
}

console.log("\nAssistant IA du back-office (tous onglets)");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterAdmin(ctx);
  const page = await ctx.newPage();
  const sse = (texte) => `data: ${JSON.stringify({ type: "chunk", text: texte })}\n\ndata: ${JSON.stringify({ type: "done", conversation: null })}\n\n`;
  // Le LLM est simulé (aucune clé en test) ; tout le reste est réel : prompt, /execute, base PostgreSQL, rafraîchissement.
  async function repondre(texte) {
    await page.route("**/api/admin/assistant/ask", (route) => {
      page.__requete = JSON.parse(route.request().postData());
      route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(texte) });
    });
  }
  const plans = (await (await ctx.request.get("/api/admin/plans")).json()).plans;
  const plan = plans.find((p) => p.scope === "epreuve" && p.actif);
  await page.goto("/admin");
  await page.getByRole("tab", { name: "Formules" }).click();
  await page.getByText("Les formules actives sont proposées").waitFor({ timeout: 10000 });

  await test("l'assistant est disponible sur l'onglet Formules, envoie l'onglet courant", async () => {
    await repondre(`Je passe l'épreuve à 777 FCFA.\n\n\`\`\`action\n${JSON.stringify({ outil: "plan_modifier", args: { id: plan.id, prix: 777 } })}\n\`\`\`\n`);
    await page.getByRole("button", { name: "Assistant", exact: true }).filter({ visible: true }).click();
    await page.getByLabel("Question à l'assistant").fill("Passe l'épreuve à 777 FCFA");
    await page.getByRole("button", { name: "Envoyer" }).click();
    await page.getByText("Modifier une formule d'abonnement").waitFor({ timeout: 10000 });
    ok(page.__requete.onglet === "formules", "onglet envoyé : " + page.__requete.onglet);
    ok(/777/.test(await page.locator("pre").last().innerText()), "arguments non affichés avant confirmation");
    const avant = (await (await ctx.request.get("/api/admin/plans")).json()).plans.find((p) => p.id === plan.id).prix;
    ok(avant === plan.prix, "le prix a changé AVANT la confirmation !");
    await page.screenshot({ path: `${SHOTS}/assistant-admin.png` });
  });

  await test("« Confirmer » exécute l'action : base mise à jour, journal, panneau rafraîchi", async () => {
    await page.getByRole("button", { name: "Confirmer", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Action exécutée" }).waitFor({ timeout: 10000 });
    const p = (await (await ctx.request.get("/api/admin/plans")).json()).plans.find((x) => x.id === plan.id);
    ok(p.prix === 777, "prix en base : " + p.prix);
    await page.waitForFunction(() => [...document.querySelectorAll("input[type=number]")].some((i) => i.value === "777"), null, { timeout: 8000 });
    const ev = await (await ctx.request.get("/api/admin/events?limit=20")).json();
    ok(JSON.stringify(ev).includes("assistant_action"), "action absente du journal");
    await ctx.request.patch(`/api/admin/plans/${plan.id}`, { data: { prix: plan.prix } });
  });

  await test("« Ignorer » n'exécute rien ; une action interdite proposée par le modèle est refusée par le serveur", async () => {
    await page.unroute("**/api/admin/assistant/ask");
    await repondre(`Je propose :\n\`\`\`action\n${JSON.stringify({ outil: "plan_modifier", args: { id: plan.id, prix: 555 } })}\n\`\`\`\n\`\`\`action\n${JSON.stringify({ outil: "utilisateur_supprimer", args: { id: "x" } })}\n\`\`\`\n`);
    await page.getByLabel("Question à l'assistant").fill("Fais deux choses");
    await page.getByRole("button", { name: "Envoyer" }).click();
    await page.getByText("utilisateur_supprimer").waitFor({ timeout: 10000 });
    const cartes = page.getByRole("button", { name: "Ignorer", exact: true });
    await cartes.first().click();
    await page.getByText("Ignorée.").waitFor();
    await page.getByRole("button", { name: "Confirmer", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Échec" }).waitFor({ timeout: 10000 });
    const p = (await (await ctx.request.get("/api/admin/plans")).json()).plans.find((x) => x.id === plan.id);
    ok(p.prix === plan.prix, "une action ignorée ou refusée a modifié la base : " + p.prix);
  });

  await test("onglet Calendrier : question sur l'onglet (le résumé vient du serveur) et pas de doublon d'assistant sur Épreuves", async () => {
    await page.unroute("**/api/admin/assistant/ask");
    await repondre("Il y a des événements au calendrier.");
    await page.getByRole("tab", { name: "Calendrier" }).click();
    await page.getByLabel("Question à l'assistant").fill("Que contient le calendrier ?");
    await page.getByRole("button", { name: "Envoyer" }).click();
    await page.getByText("Il y a des événements au calendrier.").waitFor({ timeout: 10000 });
    ok(page.__requete.onglet === "calendrier", "onglet : " + page.__requete.onglet);
    await page.getByRole("tab", { name: "Épreuves" }).click();
    ok((await page.getByLabel("Question à l'assistant").count()) === 0, "l'assistant global ne doit pas apparaître sur l'onglet Épreuves");
  });
  await ctx.close();
}

console.log("\nPanneaux de discussion (élève et admin d'épreuve)");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterEleve(ctx, `chat-${RUN}@test.cm`);
  const page = await ctx.newPage();
  const liste = await (await ctx.request.get("/api/epreuves?q=mathematiques&limit=50")).json();
  // L'épreuve du jeu de test (formules KaTeX) : la première gratuite peut être une épreuve sans contenu.
  const id = (liste.find((e) => e.acces === "gratuit" && /Exercice sur les fonctions/.test(e.extrait ?? "")) ?? liste.find((e) => e.acces === "gratuit")).id;
  const boite = () => page; // le panneau élève est un volet latéral (pas un role=dialog) : champs et boutons ont des noms uniques sur la page
  const poser = async (q) => {
    await boite().getByLabel("Question à Tuteur IA Prep").fill(q);
    await boite().getByRole("button", { name: "Envoyer" }).click();
  };

  await test("assistant élève : question, réponse, modification de la question, relance, note", async () => {
    await page.goto(`/epreuve/${id}`);
    await page.locator(".katex").first().waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Ouvrir Tuteur IA Prep" }).click();
    await poser("Explique la question 1");
    await boite().getByText("Explique la question 1").waitFor({ timeout: 10000 });
    await boite().getByRole("button", { name: "Réessayer" }).waitFor({ timeout: 20000 });
    const reponses = () => boite().locator("[data-role='assistant'], .prose-chat").count();
    ok((await reponses()) >= 1, "aucune réponse de l'assistant");
    await page.screenshot({ path: `${SHOTS}/chat-eleve.png` });
    // Modifier la question → régénération depuis ce point
    await boite().getByRole("button", { name: "Modifier", exact: true }).first().click();
    await boite().getByLabel("Modifier ta question").fill("Explique la question 2");
    await boite().getByRole("button", { name: "Valider" }).click();
    await boite().getByText("Explique la question 2").waitFor({ timeout: 10000 });
    await boite().getByRole("button", { name: "Réessayer" }).waitFor({ timeout: 20000 });
    // L'édition REMPLACE la réponse (régénération depuis ce point) au lieu d'en ajouter une : une seule réponse sauvegardable.
    ok((await boite().getByRole("button", { name: "Sauvegarder en note" }).count()) === 1, "la modification a ajouté une réponse au lieu de la remplacer");
    // Relancer la dernière question : toujours UNE seule réponse après la relance
    const avant = await boite().getByRole("button", { name: "Sauvegarder en note" }).count();
    await boite().getByRole("button", { name: "Réessayer" }).click();
    await boite().getByRole("button", { name: "Réessayer" }).waitFor({ timeout: 20000 });
    ok((await boite().getByRole("button", { name: "Sauvegarder en note" }).count()) === avant, "la relance a dupliqué la réponse");
    // Sauvegarde de la réponse en note personnelle
    await boite().getByRole("button", { name: "Sauvegarder en note" }).last().click();
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click(); // fenêtre « Prendre une note » préremplie avec la réponse
    await page.getByText("Note enregistrée — retrouvable dans ton profil.").waitFor({ timeout: 10000 });
    const notes = await (await ctx.request.get("/api/me/notes")).json();
    ok(Array.isArray(notes) ? notes.length >= 1 : (notes.notes ?? []).length >= 1, "note absente");
  });

  const admin = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterAdmin(admin);
  const pa = await admin.newPage();
  await test("assistant d'édition (admin › Épreuves) : réponse, « Appliquer au sujet », modification, relance", async () => {
    const sse = (t) => `data: ${JSON.stringify({ type: "chunk", text: t })}\n\ndata: ${JSON.stringify({ type: "done", conversation: null })}\n\n`;
    let n = 0;
    await pa.route("**/api/admin/assistant/ask", (route) => {
      n += 1;
      route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(`Voici (essai ${n}).\n\`\`\`modification-sujet\n# Sujet réécrit ${n}\n\`\`\`\n`) });
    });
    await pa.goto("/admin");
    await pa.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    const d = pa.getByRole("dialog", { name: "Tuteur IA Prep" });
    await d.getByLabel("Appliquer automatiquement").uncheck(); // parcours manuel (l'automatique est testé plus bas)
    await d.getByLabel("Question à Tuteur IA Prep").fill("Réécris le sujet");
    await d.getByRole("button", { name: "Envoyer" }).click();
    await d.getByRole("button", { name: "Appliquer au sujet" }).waitFor({ timeout: 10000 });
    await pa.screenshot({ path: `${SHOTS}/chat-admin.png` });
    await d.getByRole("button", { name: "Appliquer au sujet" }).click();
    await pa.waitForFunction(() => [...document.querySelectorAll("textarea")].some((t) => t.value.includes("# Sujet réécrit 1")), null, { timeout: 8000 });
    await d.getByRole("button", { name: "Modifier", exact: true }).first().click();
    await d.getByLabel("Modifier ta question").fill("Réécris le corrigé");
    await d.getByRole("button", { name: "Valider" }).click();
    await d.getByText("Réécris le corrigé").waitFor({ timeout: 10000 });
    await d.getByRole("button", { name: "Réessayer" }).waitFor({ timeout: 10000 });
    await d.getByRole("button", { name: "Réessayer" }).click();
    await d.getByText("Voici (essai 3).").waitFor({ timeout: 10000 }); // 1 = question, 2 = question modifiée, 3 = relance
    ok((await d.getByText(/^Voici \(essai/).count()) === 1, "plusieurs réponses affichées après la relance");
  });
  await admin.close();
  await ctx.close();
}

console.log("\nAssistant d'édition : application automatique");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterAdmin(ctx);
  const page = await ctx.newPage();
  const BROUILLON = "Exercice 1 : calculer la dérivée de f. Exercice 2 : calculer la dérivée de g.";
  const envoyees = [];
  let reponse = "";
  await page.route("**/api/admin/assistant/ask", (route) => {
    envoyees.push(route.request().postDataJSON());
    route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "chunk", text: reponse })}\n\ndata: ${JSON.stringify({ type: "done", conversation: null })}\n\n` });
  });
  const bloc = (verbe, corps) => `Voici.\n\`\`\`${verbe}\n${corps}\n\`\`\`\n`;
  const paire = (chercher, remplacer) => `<<<<<<< CHERCHER\n${chercher}\n=======\n${remplacer}\n>>>>>>> REMPLACER`;
  const zone = (n) => page.locator("textarea").nth(n);
  const d = page.getByRole("dialog", { name: "Tuteur IA Prep" });
  const poser = async (question, texte) => {
    reponse = texte;
    await d.getByLabel("Question à Tuteur IA Prep").fill(question);
    await d.getByRole("button", { name: "Envoyer" }).click();
  };
  const boutonAnnuler = d.getByRole("button", { name: "Annuler la dernière application" });
  const boutonManuel = d.getByRole("button", { name: /^Appliquer (au|\d)/ });
  const surligne = (sel = "") => page.locator(`[data-modifie]${sel}`);
  const ouvrir = async () => {
    await page.goto("/admin");
    await zone(0).fill(BROUILLON); // brouillon : jamais enregistré
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
  };

  await ouvrir();
  await test("automatique (par défaut) : lit le brouillon NON enregistré, applique à la fin de la réponse, signale le champ", async () => {
    ok(await d.getByLabel("Appliquer automatiquement").isChecked(), "la case doit être cochée par défaut");
    await poser("Précise l'exercice 1", bloc("remplacer-sujet:1", paire("Exercice 1 : calculer la dérivée de f.", "Exercice 1 : calculer la dérivée de f(x) = x².")));
    await d.getByText("Appliqué automatiquement au formulaire").waitFor({ timeout: 10000 });
    const p = envoyees[0].epreuve;
    ok(/^brouillon:[0-9a-f]{32}$/.test(envoyees[0].epreuve_id), `épreuve non enregistrée : la clé du brouillon est attendue, reçu ${envoyees[0].epreuve_id}`);
    ok(p.sujets[0].contenu_markdown === BROUILLON && p.contenu_markdown === BROUILLON, `l'assistant n'a pas reçu le brouillon : ${JSON.stringify(p.sujets)}`);
    ok(p.sujet_actif === 1, "le sujet affiché n'est pas transmis");
    const texte = await zone(0).inputValue();
    ok(texte.includes("f(x) = x²") && texte.includes("Exercice 2 : calculer la dérivée de g."), `application incorrecte : ${texte}`);
    ok((await surligne(":has(textarea)").count()) === 1, "seule la zone du sujet doit être signalée");
    ok((await boutonManuel.count()) === 0, "les boutons manuels ne doivent plus être proposés");
    await page.screenshot({ path: `${SHOTS}/assistant-auto.png` });
  });

  await test("« Annuler » restaure le formulaire d'avant et efface le signalement", async () => {
    await boutonAnnuler.click();
    ok((await zone(0).inputValue()) === BROUILLON, "le brouillon d'origine n'est pas restauré");
    ok((await surligne().count()) === 0 && (await boutonAnnuler.count()) === 0, "signalement ou bouton Annuler encore présents");
    await boutonManuel.first().waitFor({ timeout: 5000 }); // les boutons manuels reviennent
  });

  await test("dès que l'admin tape, le signalement disparaît et « Annuler » n'est plus proposé (sa saisie n'est jamais écrasée)", async () => {
    await poser("Précise l'exercice 1", bloc("remplacer-sujet:1", paire("Exercice 1", "Exercice 1 bis")));
    await d.getByText("Appliqué automatiquement au formulaire").waitFor({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await zone(0).fill(`${await zone(0).inputValue()} (ma note)`);
    ok((await surligne().count()) === 0, "le signalement doit disparaître à la première frappe");
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    ok((await boutonAnnuler.count()) === 0, "« Annuler » écraserait la saisie");
    ok((await zone(0).inputValue()).endsWith("(ma note)"), "saisie perdue");
    await zone(0).fill(BROUILLON);
  });

  await test("échecs : extrait introuvable puis ambigu — rien n'est appliqué, rien à annuler", async () => {
    await poser("Corrige", bloc("remplacer-sujet:1", paire("Texte absent du sujet", "X")));
    await page.getByText(/extrait introuvable/).waitFor({ timeout: 10000 });
    await poser("Corrige encore", bloc("remplacer-sujet:1", paire("calculer la dérivée", "Y")));
    await page.getByText(/extrait présent plusieurs fois/).waitFor({ timeout: 10000 });
    ok((await zone(0).inputValue()) === BROUILLON, "le sujet a été modifié malgré l'échec");
    ok((await surligne().count()) === 0 && (await boutonAnnuler.count()) === 0, "un échec ne doit rien signaler ni proposer d'annuler");
    ok((await d.getByText("Appliqué automatiquement au formulaire").count()) === 0, "faux « appliqué »");
  });

  await test("case décochée : rien n'est appliqué tout seul, bouton manuel, préférence mémorisée", async () => {
    await d.getByLabel("Appliquer automatiquement").uncheck();
    await poser("Précise l'exercice 2", bloc("remplacer-sujet:1", paire("Exercice 2 : calculer la dérivée de g.", "Exercice 2 : calculer la dérivée de g(x) = 3x.")));
    const manuel = d.getByRole("button", { name: "Appliquer 1 modification au sujet 1" });
    await manuel.waitFor({ timeout: 10000 });
    ok((await zone(0).inputValue()) === BROUILLON, "appliqué malgré la case décochée");
    await manuel.click();
    await page.waitForFunction(() => document.querySelector("textarea").value.includes("g(x) = 3x"), null, { timeout: 8000 });
    ok((await surligne(":has(textarea)").count()) === 1, "le champ modifié à la main doit aussi être signalé");
    await page.reload();
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    ok(!(await d.getByLabel("Appliquer automatiquement").isChecked()), "la préférence n'est pas mémorisée");
    await d.getByLabel("Appliquer automatiquement").check();
  });

  await test("sujet non affiché modifié : son onglet est signalé, et sa zone une fois ouvert", async () => {
    await page.keyboard.press("Escape");
    await zone(0).fill(BROUILLON);
    await page.getByRole("button", { name: "Ajouter un sujet" }).click();
    await page.getByRole("tab", { name: "Sujet 1" }).click();
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    await poser("Rédige le corrigé du sujet 2", bloc("modification-corrige:2", "Corrigé du sujet 2"));
    await d.getByText("Appliqué automatiquement au formulaire").waitFor({ timeout: 10000 });
    ok((await surligne(":has([role=tab])").count()) === 1 && (await surligne(":has(textarea)").count()) === 0, "seul l'onglet du sujet 2 doit être signalé");
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Sujet 2" }).click();
    ok((await zone(1).inputValue()) === "Corrigé du sujet 2" && (await surligne(":has(textarea)").count()) === 1, "la zone du corrigé n° 2 n'est pas signalée");
  });
  await ctx.close();
}

console.log("\nMémoire de l'assistant admin (onglets et brouillon)");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterAdmin(ctx);
  const page = await ctx.newPage();
  const conversation = async (cle) => (await (await ctx.request.get(`/api/admin/assistant/conversation/${cle}`)).json()).conversation;
  const bouton = (nom) => page.getByRole("button", { name: nom, exact: true }).filter({ visible: true });
  const journal = page.getByRole("log");
  const poser = async (champ, question) => {
    // La réponse est celle du LLM RÉEL si une clé est configurée, sinon la
    // réponse simulée [Mode démonstration] : ne pas attendre un texte donné.
    // Le panneau ADMIN rend la question en texte simple : seul un nouveau
    // bloc .prose-chat (la réponse) prouve que l'échange a été rendu.
    const avantChat = await journal.locator(".prose-chat").count();
    await page.getByLabel(champ).fill(question); // attend l'activation du champ (chargement de la discussion)
    await page.getByRole("button", { name: "Envoyer" }).click();
    await journal.locator(".prose-chat").nth(avantChat).waitFor({ timeout: 20000 });
  };

  await test("onglets : la discussion revient après rechargement (sans doublon de question), chaque onglet a la sienne", async () => {
    const Q = `Combien de formules ? ${RUN}`;
    await ctx.request.delete("/api/admin/assistant/conversation/onglet:formules"); // départ propre, quel que soit l'état de la base
    await page.goto("/admin");
    await page.getByRole("tab", { name: "Formules" }).click();
    await bouton("Assistant").click();
    await poser("Question à l'assistant", Q);
    const conv = await conversation("onglet:formules");
    ok(conv.messages.filter((m) => m.role === "user" && m.content === Q).length === 1 && conv.messages.length === 2, `la question est dupliquée en base : ${JSON.stringify(conv.messages.map((m) => m.role))}`);
    await page.reload();
    await page.getByRole("tab", { name: "Formules" }).click();
    await bouton("Assistant").click();
    await journal.getByText(Q).first().waitFor({ timeout: 10000 });
    ok((await journal.locator(".prose-chat").count()) >= 1, "la réponse n'est pas revenue");
    await page.getByRole("tab", { name: "Calendrier" }).click(); // le tiroir reste ouvert
    ok((await journal.getByText(Q).count()) === 0, "la discussion de Formules apparaît sur Calendrier");
    await page.getByRole("tab", { name: "Formules" }).click();
    await journal.getByText(Q).first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/assistant-memoire.png` });
  });

  await test("onglets : « Nouvelle conversation » efface la discussion, aussi côté serveur", async () => {
    await page.getByRole("button", { name: /Nouvelle conversation/ }).click();
    await page.getByText("Pose une question sur cet onglet").waitFor({ timeout: 5000 });
    await page.waitForFunction(async () => (await (await fetch("/api/admin/assistant/conversation/onglet:formules")).json()).conversation === null, null, { timeout: 8000 });
    await page.reload();
    await page.getByRole("tab", { name: "Formules" }).click();
    await bouton("Assistant").click();
    await page.getByText("Pose une question sur cet onglet").waitFor({ timeout: 10000 });
  });

  await test("éditeur : la discussion d'un brouillon revient à la réouverture, puis suit l'épreuve à l'enregistrement", async () => {
    const cles = [];
    page.on("request", (r) => r.url().includes("/api/admin/assistant/ask") && cles.push(r.postDataJSON().epreuve_id));
    const Q = `Aide-moi sur ce brouillon ${RUN}`;
    await page.goto("/admin");
    await page.getByRole("combobox", { name: /^Niveau/ }).fill("Secondaire");
    await page.getByRole("combobox", { name: /^Classe/ }).fill("Terminale");
    await page.getByRole("combobox", { name: /^Évaluation/ }).fill("Baccalauréat");
    await page.getByRole("combobox", { name: /^Année/ }).fill("2031");
    await page.getByRole("combobox", { name: /^Matière/ }).fill(`Mémoire ${RUN}`);
    await page.getByRole("button", { name: "C", exact: true, pressed: false }).click();
    await page.locator("textarea").first().fill("Exercice du brouillon.");
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    const d = page.getByRole("dialog", { name: "Tuteur IA Prep" });
    await poser("Question à Tuteur IA Prep", Q);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    await d.getByText(Q, { exact: true }).waitFor({ timeout: 10000 }); // rechargée du serveur à la réouverture
    ok(/^brouillon:[0-9a-f]{32}$/.test(cles[0]), `clé de brouillon attendue, reçu ${cles[0]}`);
    await page.keyboard.press("Escape");
    const creation = page.waitForResponse((r) => r.url().endsWith("/api/admin/epreuves") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    const id = (await (await creation).json()).id;
    await page.getByText("Épreuve créée (brouillon).").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    await d.getByText(Q, { exact: true }).waitFor({ timeout: 10000 });
    ok((await conversation(cles[0])) === null, "la discussion est restée sur la clé du brouillon");
    ok((await conversation(id))?.messages[0].content === Q, "la discussion n'a pas suivi l'épreuve enregistrée");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Nouvelle épreuve/ }).click(); // nouveau brouillon : nouvelle discussion
    await page.getByRole("button", { name: "Ouvrir l'assistant admin" }).click();
    await d.getByText("Pose ta première question").waitFor({ timeout: 10000 });
    ok((await d.getByText(Q, { exact: true }).count()) === 0, "le nouveau brouillon hérite de la discussion précédente");
    await ctx.request.delete(`/api/admin/epreuves/${id}`);
  });
  await ctx.close();
}

console.log("\nLecteur : feuille de largeur A4 et immersion");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterEleve(ctx, `feuille-${RUN}@test.cm`);
  const page = await ctx.newPage();
  const gratuit = await creerEpreuveRiche(`Feuille ${RUN}`, "2037");
  const feuille = page.locator("div[style*='zoom']").first();
  const panneau = page.locator("#panel-epreuve");
  const boite = async (loc) => loc.boundingBox();
  const A4 = (210 / 25.4) * 96; // 793,7 px CSS

  await page.goto(`/epreuve/${gratuit}`);
  await feuille.waitFor({ timeout: 15000 });

  await test("web : le texte est présenté sur une feuille de largeur A4, centrée, et non sur toute la largeur", async () => {
    const f = await boite(feuille), p = await boite(panneau);
    ok(Math.abs(f.width - A4) <= 3, `largeur de la feuille ${f.width} px, attendu ${Math.round(A4)} px (210 mm)`);
    ok(p.width - f.width >= 200, `la feuille remplit le panneau : ${f.width} / ${p.width}`);
    ok(Math.abs((f.x - p.x) - (p.x + p.width - (f.x + f.width))) <= 24, `feuille non centrée : marge gauche ${f.x - p.x}, droite ${p.x + p.width - f.x - f.width}`);
    await page.screenshot({ path: `${SHOTS}/lecteur-feuille.png` });
  });

  await test("web : A+ agrandit la feuille entière (zoom de page), A− la rétrécit", async () => {
    const avant = (await boite(feuille)).width;
    await page.getByRole("button", { name: "Agrandir le texte" }).click();
    const plus = (await boite(feuille)).width;
    ok(plus > avant + 5, `A+ : ${avant} → ${plus}`);
    await page.getByRole("button", { name: "Réduire le texte" }).click();
    await page.getByRole("button", { name: "Réduire le texte" }).click();
    ok((await boite(feuille)).width < avant - 5, "A− ne rétrécit pas la feuille");
    await page.getByRole("button", { name: "Agrandir le texte" }).click(); // retour à la taille d'origine
  });

  await test("mobile : la feuille prend toute la largeur utile, sans débordement", async () => {
    const m = await nouveauContexte({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    await connecterEleve(m, `feuille-m-${RUN}@test.cm`);
    const pm = await m.newPage();
    await pm.goto(`/epreuve/${gratuit}`);
    const fm = pm.locator("div[style*='zoom']").first();
    await fm.waitFor({ timeout: 15000 });
    const b = await fm.boundingBox();
    ok(b.width >= 390 - 60 && b.width <= 390, `feuille mobile : ${b.width} px sur 390`);
    ok(await pm.evaluate(() => { const d = document.documentElement; return innerWidth === d.clientWidth && d.scrollWidth <= d.clientWidth; }), "la feuille fait déborder la page mobile");
    await m.close();
  });

  await test("immersion : le site s'efface, la zone de lecture grandit, le choix est mémorisé, le retour reste possible", async () => {
    await page.goto("/");
    await page.goto(`/epreuve/${gratuit}`);
    await feuille.waitFor({ timeout: 15000 });
    const entete = page.locator("header[data-chrome]");
    ok(await entete.isVisible(), "en-tête absent hors immersion");
    const h0 = (await boite(panneau)).height;
    await page.getByRole("button", { name: "Immersion", exact: true }).click();
    await entete.waitFor({ state: "hidden", timeout: 5000 });
    ok(!(await page.locator("footer[data-chrome]").isVisible()), "pied de page encore visible");
    const h1 = (await boite(panneau)).height;
    ok(h1 >= h0 + 200, `zone de lecture : ${h0} → ${h1} px (site masqué ET outils repliés)`);
    // Outils repliés par défaut en immersion : plus de place encore, sans démonter les composants à état (chrono, examen).
    await page.getByRole("button", { name: "Outils", exact: true }).waitFor({ timeout: 5000 });
    ok(!(await page.getByRole("button", { name: "Examen blanc" }).isVisible()), "les outils devraient être repliés");
    await page.screenshot({ path: `${SHOTS}/lecteur-immersion.png` });
    await page.getByRole("button", { name: "Outils", exact: true }).click();
    await page.getByRole("button", { name: "Examen blanc" }).waitFor({ timeout: 5000 });
    ok((await boite(panneau)).height < h1 - 100, "ouvrir les outils doit reprendre de la place à la lecture");
    await page.getByRole("button", { name: "Chrono" }).evaluate((e) => (e.dataset.marque = "1")); // repère posé sur le DOM du chrono
    await page.getByRole("button", { name: "Outils", exact: true }).click(); // replie
    await page.getByRole("button", { name: "Outils", exact: true }).click(); // rouvre
    ok((await page.locator("[data-marque]").count()) === 1, "le chrono a été démonté puis recréé : son état serait perdu");
    await page.getByRole("button", { name: "Outils", exact: true }).click(); // replie à nouveau
    await page.reload();
    await feuille.waitFor({ timeout: 15000 });
    ok(!(await page.locator("header[data-chrome]").isVisible()), "l'immersion n'est pas mémorisée");
    await page.getByRole("button", { name: "Retour" }).click(); // le site a disparu : le retour est dans le lecteur
    await page.waitForURL((u) => u.pathname === "/", { timeout: 10000 });
    ok(await page.locator("header[data-chrome]").isVisible(), "l'immersion fuit hors du lecteur (en-tête masqué sur l'accueil)");
    await page.goto(`/epreuve/${gratuit}`);
    await page.getByRole("button", { name: "Quitter l'immersion" }).click();
    await page.locator("header[data-chrome]").waitFor({ timeout: 5000 });
    await page.reload();
    await feuille.waitFor({ timeout: 15000 });
    ok(await page.locator("header[data-chrome]").isVisible(), "la sortie d'immersion n'est pas mémorisée");
  });

  // ----- Contenu large : jamais au-delà du bord droit de la feuille ; zoom ; pincement -----
  const LARGE = [
    "# Sujet large", "",
    "Mot très long : " + "Anticonstitutionnellement".repeat(6) + " fin.", "",
    "URL : https://exemple.org/" + "segment-de-chemin-tres-long/".repeat(8), "",
    "| " + Array.from({ length: 10 }, (_, i) => `Colonne ${i + 1}`).join(" | ") + " |", "|" + "---|".repeat(10), "| " + Array.from({ length: 10 }, (_, i) => i + 1).join(" | ") + " |", "",
    "$$ f(x) = " + Array.from({ length: 14 }, (_, i) => `a_{${i}} x^{${i}}`).join(" + ") + " $$", "",
    "```", "une_ligne_de_code_tres_longue_qui_depasse_largement_la_largeur_de_la_feuille_a4_" + "x".repeat(60), "```", "",
    ...Array.from({ length: 30 }, (_, i) => `Question ${i + 1}.`).flatMap((l) => [l, ""]),
  ].join("\n");
  const large = await creerEpreuveRiche(`Large ${RUN}`, "2038", LARGE);
  const debordements = (pg) => pg.evaluate(() => {
    const f = document.querySelector("div[style*='zoom']"), fr = f.getBoundingClientRect(), panneau = document.querySelector("#panel-epreuve");
    const fautifs = [];
    for (const e of f.querySelectorAll("*")) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.right <= fr.right + 1 || e.closest(".katex-mathml")) continue; // .katex-mathml : copie accessible rognée, invisible
      let protege = false;
      for (let a = e.parentElement; a && a !== f; a = a.parentElement) if (/(auto|scroll)/.test(getComputedStyle(a).overflowX)) protege = true;
      if (!protege) fautifs.push(`${e.tagName.toLowerCase()} → ${Math.round(r.right)} > ${Math.round(fr.right)}`);
    }
    const d = document.documentElement;
    return { fautifs: fautifs.slice(0, 4), panneau: panneau.scrollWidth - panneau.clientWidth, feuille: f.scrollWidth - f.clientWidth, page: d.scrollWidth - d.clientWidth };
  });
  for (const [vue, options] of [["bureau", { viewport: { width: 1366, height: 900 } }], ["mobile", { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }]]) {
    for (const zoom of ["1", "2"]) {
      await test(`${vue} · zoom ${zoom} : tableau, code, formule, mot et adresse longs restent dans la feuille (rien ne déborde à droite)`, async () => {
        const c = await nouveauContexte(options);
        await c.addInitScript((z) => localStorage.setItem("bacprep-zoom-lecteur", z), zoom);
        await connecterEleve(c, `large-${vue}-${zoom}-${RUN}@test.cm`);
        const pg = await c.newPage();
        await pg.goto(`/epreuve/${large}`);
        await pg.locator("div[style*='zoom']").first().waitFor({ timeout: 15000 });
        await pg.waitForTimeout(1200); // formules KaTeX
        const d = await debordements(pg);
        ok(d.fautifs.length === 0, "éléments hors de la feuille : " + d.fautifs.join(" ; "));
        ok(d.panneau <= 1 && d.feuille <= 1 && d.page <= 0, `défilement horizontal : panneau ${d.panneau}, feuille ${d.feuille}, page ${d.page}`);
        if (vue === "bureau" && zoom === "1") await pg.screenshot({ path: `${SHOTS}/lecteur-contenu-large.png` });
        await c.close();
      });
    }
  }

  await test("A− descend jusqu'à 40 % (puis se bloque), le niveau est mémorisé", async () => {
    const c = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
    await connecterEleve(c, `reduit-${RUN}@test.cm`);
    const pg = await c.newPage();
    await pg.goto(`/epreuve/${gratuit}`);
    const f = pg.locator("div[style*='zoom']").first();
    await f.waitFor({ timeout: 15000 });
    const zoom = () => f.evaluate((e) => parseFloat(getComputedStyle(e).zoom));
    for (let i = 0; i < 12; i++) if (await pg.getByRole("button", { name: "Réduire le texte" }).isEnabled()) await pg.getByRole("button", { name: "Réduire le texte" }).click();
    ok(Math.abs((await zoom()) - 0.4) < 0.01, `zoom minimal : ${await zoom()}`);
    ok(await pg.getByRole("button", { name: "Réduire le texte" }).isDisabled(), "A− devrait être bloqué à 40 %");
    const largeur = (await f.boundingBox()).width;
    ok(Math.abs(largeur - 0.4 * A4) <= 3, `feuille à 40 % : ${largeur} px`);
    await pg.reload();
    await f.waitFor({ timeout: 15000 });
    ok(Math.abs((await zoom()) - 0.4) < 0.01, "le niveau n'est pas mémorisé");
    await c.close();
  });

  await test("mobile : le pincement sur la feuille zoome l'épreuve (mémorisé), pas la page du site", async () => {
    const c = await nouveauContexte({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    await connecterEleve(c, `pince-${RUN}@test.cm`);
    const pg = await c.newPage();
    await pg.goto(`/epreuve/${gratuit}`);
    const f = pg.locator("div[style*='zoom']").first();
    await f.waitFor({ timeout: 15000 });
    const cdp = await c.newCDPSession(pg);
    const doigts = (cx, cy, ecart) => [{ x: cx - ecart / 2, y: cy, id: 0 }, { x: cx + ecart / 2, y: cy, id: 1 }];
    const pincer = async (de, vers) => {
      const b = await f.boundingBox(), zone = await pg.locator("#panel-epreuve").boundingBox();
      const cx = Math.round(b.x + b.width / 2), cy = Math.round(zone.y + zone.height / 2); // les doigts sont sur la feuille, pas sur les outils
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: doigts(cx, cy, de) });
      for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: doigts(cx, cy, de + ((vers - de) * i) / 8) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await pg.waitForTimeout(300);
    };
    const zoom = () => f.evaluate((e) => parseFloat(getComputedStyle(e).zoom));
    const page = () => pg.evaluate(() => ({ echelle: visualViewport.scale, largeur: Math.round(visualViewport.width), decalage: Math.round(visualViewport.pageLeft) }));
    const avant = await page();
    ok((await zoom()) === 1, "zoom de départ attendu : 100 %");
    await pincer(100, 150); // écartement ×1,5 : 100 % → 150 %
    ok(Math.abs((await zoom()) - 1.5) < 0.12, `pincement ×1,5 : zoom ${await zoom()}`);
    ok(JSON.stringify(await page()) === JSON.stringify(avant), `la page a été zoomée : ${JSON.stringify(await page())} au lieu de ${JSON.stringify(avant)}`);
    await pincer(200, 100); // ×0,5 : 150 % → 75 %
    ok(Math.abs((await zoom()) - 0.75) < 0.1, `pincement ×0,5 : zoom ${await zoom()}`);
    ok(JSON.stringify(await page()) === JSON.stringify(avant), "la page a été zoomée au second pincement");
    const memorise = Number(await pg.evaluate(() => localStorage.getItem("bacprep-zoom-lecteur")));
    ok(Math.abs(memorise - (await zoom())) < 0.01, `zoom non mémorisé : ${memorise}`);
    await pg.reload();
    await f.waitFor({ timeout: 15000 });
    ok(Math.abs((await zoom()) - memorise) < 0.01, "le zoom pincé n'est pas restauré");
    await c.close();
  });
  await ctx.close();
}

console.log("\nAlarme sonore du chronomètre et de l'examen blanc");
{
  const unMn = await creerEpreuveRiche(`Alarme ${RUN}`, "2039", null, "1min"); // durée officielle : 1 minute
  // Espion : compte les bips réellement envoyés au moteur audio (chaque bip = un oscillateur).
  const espion = () => {
    window.__bips = 0;
    const AC = window.AudioContext;
    window.AudioContext = class extends AC {
      createOscillator() {
        window.__bips++;
        return super.createOscillator();
      }
    };
  };
  const nouvelleSession = async (nom, { init = [], viewport = { width: 1366, height: 900 } } = {}) => {
    const c = await nouveauContexte({ viewport });
    await c.addInitScript(espion);
    for (const f of init) await c.addInitScript(f);
    await connecterEleve(c, `alarme-${nom}-${RUN}@test.cm`);
    return { c, pg: await c.newPage() };
  };
  const bips = (pg) => pg.evaluate(() => window.__bips);
  const lancerChrono = async (pg, minutes) => {
    await pg.getByRole("button", { name: "Chrono" }).click();
    await pg.locator("#chrono-minutes").fill(String(minutes));
    await pg.getByRole("button", { name: "Lancer le compte à rebours" }).click();
  };
  const arret = (pg) => pg.getByRole("button", { name: "Arrêter l'alarme" });
  const idEpreuve = unMn;

  await test("chrono : à zéro l'alarme sonne EN CONTINU, « Arrêter l'alarme » la coupe aussitôt", async () => {
    const { c, pg } = await nouvelleSession("continu");
    await pg.goto(`/epreuve/${idEpreuve}`);
    await pg.getByRole("button", { name: "Chrono" }).waitFor({ timeout: 15000 });
    await lancerChrono(pg, 0.05); // 3 secondes
    await arret(pg).waitFor({ timeout: 10000 });
    await pg.screenshot({ path: `${SHOTS}/alarme-bandeau.png` });
    await pg.waitForTimeout(2600);
    const n = await bips(pg);
    ok(n >= 4, `l'alarme devrait répéter ses bips (un toutes les 0,8 s) : ${n} bip(s) en ~2,6 s`);
    await arret(pg).click();
    await arret(pg).waitFor({ state: "hidden", timeout: 3000 });
    const apres = await bips(pg);
    await pg.waitForTimeout(1800);
    ok((await bips(pg)) === apres, "des bips continuent après l'arrêt manuel");
    await c.close();
  });

  await test("chrono : sans arrêt manuel, l'alarme s'éteint seule au bout d'une minute", async () => {
    const { c, pg } = await nouvelleSession("auto");
    await pg.clock.install();
    await pg.goto(`/epreuve/${idEpreuve}`);
    await pg.getByRole("button", { name: "Chrono" }).waitFor({ timeout: 15000 });
    await lancerChrono(pg, 0.05);
    await pg.clock.runFor(4000); // le décompte (3 s) arrive à zéro
    await arret(pg).waitFor({ timeout: 5000 });
    await pg.clock.runFor(30_000);
    ok(await arret(pg).isVisible(), "l'alarme s'est arrêtée avant une minute");
    await pg.clock.runFor(31_000); // 61 s après le début de l'alarme
    await arret(pg).waitFor({ state: "hidden", timeout: 5000 });
    const n = await bips(pg);
    ok(n >= 70, `un bip toutes les 0,8 s pendant une minute : ${n}`);
    await pg.clock.runFor(10_000);
    ok((await bips(pg)) === n, "des bips continuent après l'arrêt automatique");
    await c.close();
  });

  await test("immersion, outils repliés : le bandeau reste visible et arrête l'alarme", async () => {
    const { c, pg } = await nouvelleSession("immersion");
    await pg.goto(`/epreuve/${idEpreuve}`);
    await pg.getByRole("button", { name: "Chrono" }).waitFor({ timeout: 15000 });
    await lancerChrono(pg, 0.05);
    await pg.getByRole("button", { name: "Immersion", exact: true }).click(); // site masqué, outils repliés (chrono caché)
    ok(!(await pg.locator("header[data-chrome]").isVisible()), "l'immersion n'est pas active");
    await arret(pg).waitFor({ timeout: 10000 });
    await arret(pg).click();
    await arret(pg).waitFor({ state: "hidden", timeout: 3000 });
    await c.close();
  });

  await test("couper le son depuis le chronomètre pendant que l'alarme sonne l'arrête aussi", async () => {
    const { c, pg } = await nouvelleSession("coupure");
    await pg.goto(`/epreuve/${idEpreuve}`);
    await pg.getByRole("button", { name: "Chrono" }).waitFor({ timeout: 15000 });
    await lancerChrono(pg, 0.05);
    await arret(pg).waitFor({ timeout: 10000 });
    await pg.getByRole("button", { name: "Couper le son de l'alarme" }).click(); // dans le panneau du chronomètre, resté ouvert
    await arret(pg).waitFor({ state: "hidden", timeout: 3000 });
    const n = await bips(pg);
    await pg.waitForTimeout(1800);
    ok((await bips(pg)) === n, "l'alarme continue après avoir coupé le son");
    await c.close();
  });

  await test("son coupé : aucune alarme, aucun bandeau", async () => {
    const { c, pg } = await nouvelleSession("muet", { init: [() => localStorage.setItem("bacprep-son", "off")] });
    await pg.goto(`/epreuve/${idEpreuve}`);
    await pg.getByRole("button", { name: "Chrono" }).waitFor({ timeout: 15000 });
    await lancerChrono(pg, 0.05);
    await pg.getByText("Temps écoulé !").waitFor({ timeout: 10000 }); // le signal visuel reste
    await pg.waitForTimeout(1500);
    ok((await bips(pg)) === 0 && (await arret(pg).count()) === 0, "alarme ou bandeau malgré le son coupé");
    await c.close();
  });

  await test("examen blanc : à la fin du temps l'alarme sonne jusqu'à l'arrêt manuel", async () => {
    const { c, pg } = await nouvelleSession("examen");
    await pg.clock.install();
    await pg.goto(`/epreuve/${idEpreuve}`);
    await pg.getByRole("button", { name: "Examen blanc" }).click();
    await pg.getByRole("timer", { name: "Examen blanc en cours" }).waitFor({ timeout: 10000 });
    await pg.clock.runFor(61_000); // durée officielle : 1 minute
    await arret(pg).waitFor({ timeout: 5000 });
    ok((await bips(pg)) >= 1, "aucun bip à la fin de l'examen blanc");
    await arret(pg).click();
    await arret(pg).waitFor({ state: "hidden", timeout: 3000 });
    const n = await bips(pg);
    await pg.clock.runFor(5000);
    ok((await bips(pg)) === n, "l'alarme continue après l'arrêt manuel");
    await c.close();
  });
}

console.log("\nInvitation, À propos et Aide");
{
  const ORIGINE = new URL(process.env.E2E_URL ?? "http://localhost:8765").origin;
  const SITE = `${ORIGINE}/`;
  const session = async (nom, { init = [], viewport = { width: 1366, height: 900 }, droits = false } = {}) => {
    const c = await nouveauContexte({ viewport });
    for (const f of init) await c.addInitScript(f);
    if (droits) await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGINE });
    await connecterEleve(c, `invit-${nom}-${RUN}@test.cm`);
    return { c, pg: await c.newPage() };
  };
  const dialogue = (pg) => pg.getByRole("dialog", { name: "Inviter des amis" });
  const ouvrirEnTete = async (pg) => {
    await pg.goto("/");
    await pg.locator("header").getByRole("button", { name: "Inviter des amis" }).click();
    await dialogue(pg).waitFor({ timeout: 5000 });
  };

  await test("invitation : liens WhatsApp, Facebook, Telegram et e-mail portent le message et l'adresse du site, bien encodés", async () => {
    const { c, pg } = await session("liens");
    await ouvrirEnTete(pg);
    const d = dialogue(pg);
    const href = (nom) => d.getByRole("link", { name: nom }).getAttribute("href");
    const wa = new URL(await href("WhatsApp"));
    ok(wa.origin === "https://wa.me", `WhatsApp : ${wa}`);
    ok(wa.searchParams.get("text").includes(SITE) && wa.searchParams.get("text").includes("Copies & Corrigés"), `message WhatsApp : ${wa.searchParams.get("text")}`);
    ok(new URL(await href("Facebook")).searchParams.get("u") === SITE, "Facebook : adresse partagée");
    const tg = new URL(await href("Telegram"));
    ok(tg.origin === "https://t.me" && tg.searchParams.get("url") === SITE && tg.searchParams.get("text").includes("Rejoins-moi"), "Telegram");
    ok((await href("E-mail")).startsWith("mailto:?subject="), "e-mail");
    for (const nom of ["WhatsApp", "Facebook", "Telegram"]) {
      ok((await d.getByRole("link", { name: nom }).getAttribute("target")) === "_blank" && /noopener/.test(await d.getByRole("link", { name: nom }).getAttribute("rel")), `${nom} : ouverture sans fuite de contexte`);
    }
    await pg.screenshot({ path: `${SHOTS}/invitation.png` });
    await pg.keyboard.press("Escape");
    await d.waitFor({ state: "hidden", timeout: 3000 });
    await c.close();
  });

  await test("invitation : « Copier le lien » met l'adresse du site dans le presse-papiers et le confirme", async () => {
    const { c, pg } = await session("copie", { droits: true });
    await ouvrirEnTete(pg);
    await dialogue(pg).getByRole("button", { name: "Copier le lien" }).click();
    await pg.getByText("Lien copié.").waitFor({ timeout: 5000 });
    ok((await pg.evaluate(() => navigator.clipboard.readText())) === SITE, "le presse-papiers ne contient pas l'adresse du site");
    await c.close();
  });

  await test("invitation : le partage natif (téléphone) s'ouvre avec titre, message et adresse ; l'annulation est silencieuse", async () => {
    const { c, pg } = await session("natif", { init: [() => { navigator.share = async (d) => { window.__partage = d; if (window.__annule) throw new DOMException("annulé", "AbortError"); }; }] });
    await ouvrirEnTete(pg);
    await dialogue(pg).getByRole("button", { name: "Autres applications…" }).click();
    await dialogue(pg).waitFor({ state: "hidden", timeout: 3000 }); // partage réussi : le dialogue se ferme
    const donnees = await pg.evaluate(() => window.__partage);
    ok(donnees.url === SITE && donnees.title === "Copies & Corrigés" && donnees.text.includes("Rejoins-moi"), `données de partage : ${JSON.stringify(donnees)}`);
    await pg.evaluate(() => { window.__annule = true; });
    await pg.locator("header").getByRole("button", { name: "Inviter des amis" }).click();
    await dialogue(pg).getByRole("button", { name: "Autres applications…" }).click();
    await pg.waitForTimeout(600);
    ok(await dialogue(pg).isVisible(), "l'annulation du partage ne doit pas fermer le dialogue");
    ok((await pg.getByText("Le partage n'a pas pu s'ouvrir").count()) === 0, "message d'erreur affiché après une simple annulation");
    await c.close();
  });

  await test("invitation : sans partage natif (ordinateur), le bouton « Autres applications… » est absent", async () => {
    const { c, pg } = await session("sans-natif", { init: [() => { Object.defineProperty(navigator, "share", { value: undefined, configurable: true }); }] });
    await ouvrirEnTete(pg);
    ok((await dialogue(pg).getByRole("button", { name: "Autres applications…" }).count()) === 0, "bouton natif présent sans navigator.share");
    await c.close();
  });

  await test("invitation sur mobile : accessible depuis le menu, le dialogue tient dans l'écran", async () => {
    const { c, pg } = await session("mobile", { viewport: { width: 390, height: 800 } });
    await pg.goto("/");
    ok(!(await pg.locator("header").getByRole("button", { name: "Inviter des amis" }).isVisible()), "l'icône d'en-tête ne doit pas encombrer le mobile");
    await pg.getByRole("button", { name: "Ouvrir le menu" }).click();
    await pg.getByRole("button", { name: "Inviter des amis" }).filter({ visible: true }).first().click();
    await dialogue(pg).waitFor({ timeout: 5000 });
    const b = await dialogue(pg).locator("> div").boundingBox();
    ok(b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 800, `dialogue hors écran : ${JSON.stringify(b)}`);
    await c.close();
  });

  await test("pied de page et en-tête : liens « Aide » et « À propos », « Inviter des amis »", async () => {
    const { c, pg } = await session("liens-pied");
    await pg.goto("/");
    await pg.locator("header").getByRole("link", { name: "Aide" }).click();
    await pg.getByRole("heading", { level: 1, name: "Aide" }).waitFor({ timeout: 10000 });
    await pg.locator("footer").getByRole("link", { name: "À propos" }).click();
    await pg.getByRole("heading", { level: 1, name: "À propos de Copies & Corrigés" }).waitFor({ timeout: 10000 });
    await pg.locator("footer").getByRole("button", { name: "Inviter des amis" }).click();
    await dialogue(pg).waitFor({ timeout: 5000 });
    await c.close();
  });

  await test("À propos : présente l'application, renvoie vers l'aide, n'invente aucune adresse de contact", async () => {
    const { c, pg } = await session("apropos");
    await pg.goto("/a-propos");
    await pg.getByRole("heading", { name: "Nos principes" }).waitFor({ timeout: 10000 });
    ok((await pg.getByRole("link", { name: "Nous écrire" }).count()) === 0, "adresse de contact affichée sans VITE_CONTACT_EMAIL");
    await pg.getByRole("link", { name: "Ouvrir l'aide" }).click();
    await pg.getByRole("heading", { level: 1, name: "Aide" }).waitFor({ timeout: 10000 });
    await c.close();
  });

  await test("aide d'un élève : onze rubriques, sommaire cliquable, rien de l'administration, pas de bascule", async () => {
    const { c, pg } = await session("aide-eleve");
    await pg.goto("/aide");
    await pg.getByRole("heading", { level: 1, name: "Aide" }).waitFor({ timeout: 10000 });
    ok((await pg.locator("main section h2").count()) === 11, `rubriques : ${await pg.locator("main section h2").count()}`);
    await pg.getByRole("navigation", { name: "Sommaire" }).getByRole("link", { name: "Le Tuteur IA" }).click();
    await pg.waitForFunction(() => location.hash === "#tuteur");
    const r = await pg.locator("#tuteur").boundingBox();
    ok(r.y >= 0 && r.y < 400, `la rubrique n'est pas amenée à l'écran : y = ${r.y}`);
    ok((await pg.getByText("console d'administration").count()) === 0 && (await pg.getByRole("button", { name: "Aide administrateur" }).count()) === 0, "contenu d'administration visible par un élève");
    await pg.goto("/aide?vue=admin"); // tentative de forcer la vue
    await pg.getByRole("heading", { level: 1, name: "Aide" }).waitFor({ timeout: 10000 });
    ok((await pg.getByRole("heading", { name: "Import massif" }).count()) === 0, "un élève a obtenu l'aide administrateur");
    await pg.screenshot({ path: `${SHOTS}/aide-eleve.png` });
    await c.close();
  });

  await test("aide d'un administrateur : aide de la console par défaut, bascule vers l'aide élève, et retour", async () => {
    const c = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
    await connecterAdmin(c);
    const pg = await c.newPage();
    await pg.goto("/aide");
    await pg.getByRole("heading", { level: 1, name: "Aide de la console d'administration" }).waitFor({ timeout: 10000 });
    for (const rubrique of ["Import massif", "L'assistant d'édition", "Sauvegardes", "Journal d'audit"]) await pg.getByRole("heading", { level: 2, name: rubrique }).waitFor({ timeout: 5000 });
    ok((await pg.getByRole("button", { name: "Aide administrateur" }).getAttribute("aria-pressed")) === "true", "la vue administrateur devrait être active");
    await pg.screenshot({ path: `${SHOTS}/aide-admin.png` });
    await pg.getByRole("button", { name: "Aide utilisateur" }).click();
    await pg.getByRole("heading", { level: 1, name: "Aide" }).waitFor({ timeout: 5000 });
    await pg.getByRole("heading", { level: 2, name: "Le Tuteur IA" }).waitFor({ timeout: 5000 });
    ok(pg.url().includes("vue=utilisateur") && (await pg.getByRole("heading", { name: "Import massif" }).count()) === 0, "la vue utilisateur n'est pas isolée");
    await pg.getByRole("button", { name: "Aide administrateur" }).click();
    await pg.getByRole("heading", { level: 1, name: "Aide de la console d'administration" }).waitFor({ timeout: 5000 });
    await c.close();
  });

  await test("aide : le sommaire et les rubriques restent lisibles sur mobile (sans débordement)", async () => {
    const { c, pg } = await session("aide-mobile", { viewport: { width: 390, height: 800 } });
    for (const url of ["/aide", "/a-propos"]) {
      await pg.goto(url);
      await pg.getByRole("heading", { level: 1 }).waitFor({ timeout: 10000 });
      ok(await pg.evaluate(() => { const d = document.documentElement; return innerWidth === d.clientWidth && d.scrollWidth <= d.clientWidth; }), `${url} déborde sur mobile`);
    }
    await c.close();
  });
}

console.log("\nMenu des sections du back-office repliable");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterAdmin(ctx);
  const page = await ctx.newPage();
  const largeurPanneau = async () => Math.round((await page.locator("#admin-panel").boundingBox()).width);
  const onglet = (nom) => page.getByRole("tab", { name: nom });
  await page.goto("/admin");
  await onglet("Épreuves").waitFor({ timeout: 15000 });
  const largeurOuvert = await largeurPanneau();

  await test("replier : le menu disparaît et la zone d'édition gagne la largeur du menu", async () => {
    await page.getByRole("button", { name: "Masquer le menu" }).click();
    await onglet("Épreuves").waitFor({ state: "hidden", timeout: 5000 });
    const replie = await largeurPanneau();
    ok(replie - largeurOuvert >= 200, `zone d'édition : ${largeurOuvert} px → ${replie} px`);
    await page.getByRole("button", { name: "Afficher le menu" }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${SHOTS}/admin-menu-replie.png` });
  });

  await test("replié : on change encore de section (liste déroulante) et le choix survit au rechargement", async () => {
    await page.getByLabel("Section du back-office").selectOption("formules");
    await page.getByText(/Les formules actives sont proposées/).waitFor({ timeout: 10000 });
    await page.reload();
    await page.getByRole("button", { name: "Afficher le menu" }).waitFor({ timeout: 15000 });
    ok((await onglet("Formules").count()) === 0, "le menu est revenu après rechargement");
  });

  await test("rouvrir : le menu revient avec la section courante, la navigation fonctionne, largeur d'origine", async () => {
    await page.getByRole("button", { name: "Afficher le menu" }).click();
    await onglet("Épreuves").waitFor({ timeout: 5000 });
    ok((await onglet("Épreuves").getAttribute("aria-selected")) === "true", "la section courante n'est pas sélectionnée");
    await onglet("Formules").click();
    ok((await onglet("Formules").getAttribute("aria-selected")) === "true", "la navigation par onglets ne fonctionne plus");
    ok(Math.abs((await largeurPanneau()) - largeurOuvert) <= 2, "largeur d'origine non retrouvée");
    await page.reload();
    await onglet("Épreuves").waitFor({ timeout: 15000 }); // ouvert : la préférence « ouvert » est mémorisée
  });

  await test("statistiques repliables : l'éditeur remonte d'autant, l'état est mémorisé", async () => {
    await page.goto("/admin");
    await onglet("Épreuves").waitFor({ timeout: 15000 });
    const haut = async () => Math.round((await page.locator("#admin-panel").boundingBox()).y);
    const ouvert = await haut();
    await page.getByRole("button", { name: "Masquer les statistiques" }).click();
    await page.getByRole("heading", { name: "Statistiques" }).waitFor({ state: "hidden", timeout: 5000 });
    const replie = await haut();
    ok(ouvert - replie >= 300, `l'éditeur ne remonte pas assez : ${ouvert} → ${replie} px`);
    await page.reload();
    await page.getByRole("button", { name: "Afficher les statistiques" }).waitFor({ timeout: 15000 });
    ok(Math.abs((await haut()) - replie) <= 4, "l'état replié n'est pas mémorisé");
    await page.getByRole("button", { name: "Afficher les statistiques" }).click();
    await page.getByRole("heading", { name: "Statistiques" }).waitFor({ timeout: 5000 });
    ok(Math.abs((await haut()) - ouvert) <= 4, "la position d'origine n'est pas retrouvée");
  });

  await test("mobile : la préférence « replié » n'ajoute aucun bouton, la liste déroulante reste seule", async () => {
    const m = await nouveauContexte({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    await m.addInitScript(() => localStorage.setItem("bacprep-menu-admin", "replie"));
    await connecterAdmin(m);
    const pm = await m.newPage();
    await pm.goto("/admin");
    await pm.getByLabel("Section du back-office").waitFor({ timeout: 15000 });
    ok(!(await pm.getByRole("button", { name: "Afficher le menu" }).isVisible()), "bouton de menu visible sur mobile");
    await m.close();
  });
  await ctx.close();
}

console.log("\nPhoto de profil");
{
  const ctx = await nouveauContexte({ viewport: { width: 1280, height: 900 } });
  await connecterEleve(ctx, `photo-${RUN}@test.cm`);
  const page = await ctx.newPage();
  const envois = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/me/avatar") && envois.push(r.url()));
  await page.goto("/profil");
  await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 15000 });
  // Image non carrée, générée dans le navigateur : le serveur doit la recadrer en carré de 256 px.
  const png = async (largeur, hauteur) =>
    Buffer.from(await page.evaluate(([l, h]) => { const c = document.createElement("canvas"); c.width = l; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#c79a3a"; g.fillRect(0, 0, l, h); return c.toDataURL("image/png").split(",")[1]; }, [largeur, hauteur]), "base64");
  const champ = page.getByLabel("Choisir une photo");
  const alerte = page.getByRole("alert");
  const photos = page.locator('a[href="/profil"] img[src*="/api/me/avatar?v="]').filter({ visible: true });
  const choisir = (fichier) => champ.setInputFiles(fichier);

  await test("sans photo : initiales dans l'en-tête, aucune image", async () => {
    ok((await photos.count()) === 0, "image d'avatar sans photo");
    ok((await page.locator('a[href="/profil"]').filter({ visible: true }).first().innerText()).trim().length === 2, "initiales attendues");
    await page.getByRole("button", { name: "Ajouter une photo" }).waitFor();
  });

  await test("erreurs refusées sans envoi : fichier trop lourd, fichier qui n'est pas une image", async () => {
    await choisir({ name: "grosse.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1024) });
    await alerte.filter({ hasText: "Photo trop lourde (2 Mo maximum)" }).waitFor({ timeout: 5000 });
    await choisir({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("pas une image") });
    await alerte.filter({ hasText: "Fichier non reconnu comme image" }).waitFor({ timeout: 5000 });
    ok(envois.length === 0 && (await page.getByRole("button", { name: "Enregistrer la photo" }).count()) === 0, `un envoi est parti : ${envois.length}`);
  });

  await test("erreurs du serveur : 415 réel (faux PNG), 413 et 429 traduits", async () => {
    await choisir({ name: "faux.png", mimeType: "image/png", buffer: Buffer.from("ceci n'est pas un PNG") });
    // Le navigateur ne sait pas afficher cet aperçu : même message que le refus du serveur.
    await alerte.filter({ hasText: "Fichier non reconnu comme image" }).waitFor({ timeout: 5000 });
    const bon = await png(300, 200);
    for (const [statut, texte] of [[413, "Photo trop lourde"], [429, "Trop d'envois de photo"]]) {
      await page.route("**/api/me/avatar", (route) => route.request().method() === "POST" ? route.fulfill({ status: statut, json: { detail: "x" } }) : route.continue());
      await choisir({ name: "ok.png", mimeType: "image/png", buffer: bon });
      await page.getByRole("button", { name: "Enregistrer la photo" }).click();
      await alerte.filter({ hasText: texte }).waitFor({ timeout: 5000 });
      await page.unroute("**/api/me/avatar");
      await page.getByRole("button", { name: "Annuler", exact: true }).click();
    }
    const reel = await ctx.request.post("/api/me/avatar", { multipart: { file: { name: "faux.png", mimeType: "image/png", buffer: Buffer.from("ceci n'est pas un PNG") } } });
    ok(reel.status() === 415, `le serveur doit refuser un faux PNG par 415, reçu ${reel.status()}`);
    ok((await ctx.request.get("/api/me/avatar")).status() === 404, "une erreur ne doit rien enregistrer");
  });

  await test("aperçu puis enregistrement : photo carrée de 256 px dans l'en-tête et le profil, version dans l'URL", async () => {
    await choisir({ name: "photo.png", mimeType: "image/png", buffer: await png(300, 200) });
    await page.getByRole("img", { name: "Aperçu de la nouvelle photo" }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${SHOTS}/profil-apercu.png` });
    await page.getByRole("button", { name: "Enregistrer la photo" }).click();
    await page.getByText("Photo de profil mise à jour.").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Changer la photo" }).waitFor();
    const version = (await (await ctx.request.get("/api/auth/me")).json()).avatar_version;
    ok(!!version, "avatar_version absent de /api/auth/me");
    await page.waitForFunction(() => { const i = document.querySelectorAll('img[src*="/api/me/avatar?v="]'); return i.length >= 2 && [...i].every((x) => x.complete && x.naturalWidth > 0); }, null, { timeout: 10000 });
    const dims = await photos.first().evaluate((i) => [i.naturalWidth, i.naturalHeight, i.getAttribute("src")]);
    ok(dims[0] === 256 && dims[1] === 256, `photo non recadrée en 256×256 : ${dims}`);
    ok(dims[2].includes(`?v=${encodeURIComponent(version)}`), `version absente de l'URL : ${dims[2]}`);
    ok((await page.locator('aside img[src*="/api/me/avatar?v="]').count()) === 1, "photo absente du profil");
    await page.screenshot({ path: `${SHOTS}/profil-photo.png` });
    await page.reload();
    await photos.first().waitFor({ timeout: 10000 });
  });

  await test("mobile : l'aperçu ne fait pas déborder la page", async () => {
    const m = await nouveauContexte({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    await connecterEleve(m, `photo-mobile-${RUN}@test.cm`); // autre compte : une seule session par compte
    const pm = await m.newPage();
    await pm.goto("/profil");
    await pm.getByLabel("Choisir une photo").setInputFiles({ name: "p.png", mimeType: "image/png", buffer: await png(300, 200) });
    await pm.getByRole("img", { name: "Aperçu de la nouvelle photo" }).waitFor({ timeout: 8000 });
    ok(await pm.evaluate(() => { const d = document.documentElement; return innerWidth === d.clientWidth && d.scrollWidth <= d.clientWidth; }), "l'aperçu fait déborder la page");
    await m.close();
  });

  await test("retirer la photo : retour aux initiales, aussi côté serveur", async () => {
    await page.getByRole("button", { name: "Retirer la photo" }).click();
    await page.getByText("Photo de profil retirée.").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Ajouter une photo" }).waitFor();
    ok((await photos.count()) === 0, "l'image d'avatar est restée affichée");
    ok((await ctx.request.get("/api/me/avatar")).status() === 404, "la photo est restée en base");
    ok((await (await ctx.request.get("/api/auth/me")).json()).avatar_version == null, "avatar_version non effacé");
  });
  await ctx.close();
}

console.log("\nConnexion, état du réseau, A−/A+ flottant");
{
  // --- connexion admin : message selon la CAUSE, et indicateur de chargement
  const ctx = await nouveauContexte({ viewport: { width: 1280, height: 800 } });
  await connecterEleve(ctx, ADMIN.email); // compte autorisé, SANS session admin : la page affiche le formulaire du jeton
  const page = await ctx.newPage();

  await test("connexion admin : le bouton montre un indicateur de chargement pendant le traitement", async () => {
    await page.route("**/api/admin/login", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto("/admin");
    await page.locator("#admin-login-email").fill(ADMIN.email);
    await page.locator("#admin-login-token").fill("mauvais-jeton");
    const bouton = page.getByRole("button", { name: /Se connecter/ });
    await bouton.click();
    const occupe = page.getByRole("button", { name: /Connexion…/ });
    await occupe.waitFor({ timeout: 3000 });
    ok((await occupe.getAttribute("aria-busy")) === "true" && (await occupe.isDisabled()), "bouton non désactivé / pas aria-busy");
    ok((await occupe.locator(".animate-spin").count()) === 1, "pas de cercle de chargement");
    await page.screenshot({ path: `${SHOTS}/connexion-chargement.png` });
    await page.getByRole("alert").waitFor({ timeout: 8000 });
    ok((await page.getByRole("button", { name: /Se connecter/ }).isEnabled()), "le bouton reste bloqué après la réponse");
    await page.unroute("**/api/admin/login");
  });

  await test("connexion admin : jeton refusé → message d'identifiants ; réseau coupé → message de connexion (jamais l'inverse)", async () => {
    await page.locator("#admin-login-token").fill("encore-faux");
    await page.getByRole("button", { name: /Se connecter/ }).click();
    await page.getByText("Connexion refusée — vérifie l'e-mail et le jeton.").waitFor({ timeout: 8000 });
    await ctx.setOffline(true);
    await page.locator("#admin-login-token").fill("peu-importe");
    await page.getByRole("button", { name: /Se connecter/ }).click();
    const alerte = page.getByRole("alert");
    await alerte.filter({ hasText: "Pas de connexion Internet" }).waitFor({ timeout: 8000 });
    ok(!(await alerte.innerText()).includes("jeton"), "le message hors-ligne accuse encore le jeton : " + (await alerte.innerText()));
    await page.screenshot({ path: `${SHOTS}/connexion-hors-ligne.png` });
    await ctx.setOffline(false);
  });

  await test("nuage de connexion : vert en ligne, rouge hors connexion, vert au retour du réseau", async () => {
    await page.goto("/");
    const nuage = page.getByRole("status", { name: /Connecté à Internet|Hors connexion/ });
    await nuage.waitFor({ timeout: 10000 });
    ok((await nuage.getAttribute("data-connexion")) === "ok", "pas vert au départ");
    ok(/valide/.test(await nuage.getAttribute("class")), "pas la couleur verte");
    await ctx.setOffline(true);
    await page.waitForFunction(() => document.querySelector("[data-connexion]")?.getAttribute("data-connexion") === "hors-ligne", null, { timeout: 5000 });
    ok(/correction/.test(await nuage.getAttribute("class")), "pas la couleur rouge hors connexion");
    await page.screenshot({ path: `${SHOTS}/nuage-rouge.png` });
    await ctx.setOffline(false);
    await page.waitForFunction(() => document.querySelector("[data-connexion]")?.getAttribute("data-connexion") === "ok", null, { timeout: 10000 });
  });
  await ctx.close();

  // --- connexion élève : même indicateur de chargement
  const eleve = await nouveauContexte();
  const pe = await eleve.newPage();
  await test("connexion élève : indicateur de chargement sur le bouton", async () => {
    await pe.route("**/api/auth/mock-login", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await pe.goto("/connexion");
    await pe.getByPlaceholder(/franck.albert@exemple.com|franck.albert@example.com/).fill(`spin-${RUN}@test.cm`);
    await pe.getByPlaceholder(/Franck Albert/).first().fill("Spin");
    await pe.getByRole("button", { name: /Se connecter/ }).click();
    const occupe = pe.getByRole("button", { name: /Connexion…/ });
    await occupe.waitFor({ timeout: 3000 });
    ok((await occupe.locator(".animate-spin").count()) === 1 && (await occupe.isDisabled()), "pas d'indicateur de chargement");
  });
  await eleve.close();

  // --- A−/A+ flottant sur toute l'épreuve
  const adm = await nouveauContexte();
  await connecterAdmin(adm);
  const longue = Array.from({ length: 160 }, (_, i) => `Ligne ${i + 1} : développer et réduire l'expression $(x+${i})^2$.\n`).join("\n");
  const cree = await (await adm.request.post("/api/admin/epreuves", { data: {
    niveau: "SECONDAIRE", classe: "terminale", evaluation: "BAC", matiere: "Mathématiques", annee: "2033", gratuit: true, filieres: ["C"], duree: "3h",
    contenu_markdown: "# Épreuve longue\n\n" + longue } })).json();
  await adm.request.post(`/api/admin/epreuves/${cree.id}/publish`);
  const lecteur = await nouveauContexte({ viewport: { width: 1280, height: 720 } });
  await connecterEleve(lecteur, `flot-${RUN}@test.cm`);
  const pl = await lecteur.newPage();
  await test("A−/A+ : reste visible et cliquable tout en bas d'une épreuve longue", async () => {
    await pl.goto(`/epreuve/${cree.id}`);
    await pl.getByText("Ligne 1 :").first().waitFor({ timeout: 15000 });
    const plus = pl.getByRole("button", { name: "Agrandir le texte" });
    ok((await plus.evaluate((e) => getComputedStyle(e.closest("div.fixed")).position)) === "fixed", "le contrôle n'est pas en position fixe");
    await pl.mouse.move(640, 400);
    for (let i = 0; i < 12; i++) await pl.mouse.wheel(0, 2500);
    await pl.getByText("Ligne 160 :").first().waitFor({ timeout: 8000 });
    const boite = await plus.boundingBox();
    ok(boite && boite.y >= 0 && boite.y + boite.height <= 720, "hors de l'écran après défilement : " + JSON.stringify(boite));
    const couvert = await plus.evaluate((e) => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === e || e.contains(top); });
    ok(couvert, "le contrôle est masqué par un autre élément");
    const avant = await pl.locator("div[style*='zoom']").first().evaluate((e) => getComputedStyle(e).zoom);
    await plus.click();
    const apres = await pl.locator("div[style*='zoom']").first().evaluate((e) => getComputedStyle(e).zoom);
    ok(Number(apres) > Number(avant), `zoom ${avant} → ${apres}`);
    await pl.screenshot({ path: `${SHOTS}/taille-flottante.png` });
  });
  await adm.close();
  await lecteur.close();
}

console.log("\nBack-office : navigation, listes bornées et filtrées");
{
  const ctx = await nouveauContexte({ viewport: { width: 1366, height: 900 } });
  await connecterAdmin(ctx);
  const page = await ctx.newPage();
  const ids = [];
  for (let i = 0; i < 35; i++) {
    const r = await ctx.request.post("/api/admin/notifications", { data: { titre: `ZZE2E-${RUN}-${String(i).padStart(2, "0")}`, message: "x", type: "information" } });
    ids.push((await r.json()).id);
  }
  await ctx.request.post(`/api/admin/notifications/${ids[0]}/toggle`);
  await page.goto("/admin");

  await test("navigation : panneau latéral groupé (3 familles, 10 sections), flèches ↑↓, repli en liste déroulante sur mobile", async () => {
    const liste = page.getByRole("tablist", { name: "Sections du back-office" });
    await liste.waitFor({ timeout: 15000 });
    ok((await liste.getAttribute("aria-orientation")) === "vertical", "pas vertical");
    ok((await liste.getByRole("tab").count()) === 10, "il doit y avoir 10 sections");
    for (const g of ["Contenu", "Communauté", "Système"]) await liste.getByText(g, { exact: true }).waitFor();
    const x0 = (await liste.boundingBox()).x, larg = (await liste.boundingBox()).width;
    ok(larg < 260 && x0 < 100, `panneau latéral attendu (x=${x0}, largeur=${larg})`);
    await page.getByRole("tab", { name: "Épreuves" }).focus();
    await page.keyboard.press("ArrowDown");
    ok((await page.getByRole("tab", { selected: true }).innerText()).startsWith("Import"), "ArrowDown n'avance pas d'une section");
    await page.screenshot({ path: `${SHOTS}/admin-navigation.png` });
    await page.setViewportSize({ width: 390, height: 800 });
    ok(!(await liste.isVisible()), "le panneau latéral doit disparaître sur mobile");
    const sel = page.getByLabel("Section du back-office");
    await sel.waitFor();
    await sel.selectOption("formules");
    await page.getByText("Les formules actives sont proposées").waitFor({ timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/admin-mobile.png` });
    await page.setViewportSize({ width: 1366, height: 900 });
  });

  await test("Notifications : liste de hauteur bornée qui défile, « Charger plus », recherche et filtre d'état", async () => {
    await page.getByRole("tab", { name: "Notifications" }).click();
    const liste = page.locator("ul[data-liste-admin]");
    await liste.first().waitFor({ timeout: 10000 });
    await page.getByLabel("Rechercher dans les titres et messages…").fill(`ZZE2E-${RUN}`);
    await page.getByRole("button", { name: /Charger plus \(30 affichés\)/ }).waitFor({ timeout: 8000 });
    const h = await liste.first().evaluate((e) => ({ h: e.getBoundingClientRect().height, sh: e.scrollHeight, vh: window.innerHeight, ov: getComputedStyle(e).overflowY }));
    ok(h.h <= h.vh * 0.6 + 2 && h.sh > h.h && h.ov === "auto", "liste non bornée / ne défile pas : " + JSON.stringify(h));
    await page.screenshot({ path: `${SHOTS}/admin-notifications.png` });
    await page.getByRole("button", { name: /Charger plus/ }).click();
    await page.waitForFunction((n) => document.querySelectorAll("ul[data-liste-admin] > li").length >= n, 35, { timeout: 8000 });
    await page.getByLabel("Rechercher dans les titres et messages…").fill(`ZZE2E-${RUN}-34`);
    await page.waitForFunction(() => document.querySelectorAll("ul[data-liste-admin] > li").length === 1, null, { timeout: 8000 });
    await page.getByLabel("Rechercher dans les titres et messages…").fill(`ZZE2E-${RUN}`);
    await page.getByLabel("État").selectOption("inactive");
    // On attend le résultat FILTRÉ (et non le résultat périmé de la recherche précédente).
    await page.waitForFunction(() => { const li = document.querySelectorAll("ul[data-liste-admin] > li"); return li.length === 1 && /ZZE2E-.*-00/.test(li[0].textContent); }, null, { timeout: 8000 });
  });

  await test("Signalements et Journal : filtres présents, signalements ouverts par défaut, journal filtrable", async () => {
    await page.getByRole("tab", { name: /Signalements/ }).click();
    await page.getByLabel("Statut").waitFor({ timeout: 8000 });
    ok((await page.getByLabel("Statut").inputValue()) === "ouvert", "statut par défaut ≠ ouvert");
    await page.getByLabel("Rechercher dans les messages…").waitFor();
    await page.getByRole("tab", { name: "Journal" }).click();
    const champ = page.getByLabel("Filtrer par action ou par e-mail…");
    await champ.waitFor({ timeout: 8000 });
    await champ.fill("notification_created");
    await page.waitForFunction(() => { const li = [...document.querySelectorAll("ul[data-liste-admin] > li")]; return li.length > 0 && li.every((l) => /notification/i.test(l.textContent)); }, null, { timeout: 8000 });
    await champ.fill("action-qui-nexiste-pas");
    await page.getByText("Aucun évènement ne correspond.").waitFor({ timeout: 8000 });
  });

  await test("Paramètres : cartes de hauteur FIXE et identique, liste défilante à l'intérieur", async () => {
    for (let i = 0; i < 25; i++) await ctx.request.post("/api/admin/referentiel-options", { data: { scope: "serie", code: `ZZ${RUN.toUpperCase().slice(-3)}${i}` } });
    await page.getByRole("tab", { name: "Paramètres" }).click();
    await page.locator("div.h-\\[28rem\\]").first().waitFor({ timeout: 10000 });
    const cartes = await page.locator("div.h-\\[28rem\\]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    ok(cartes.length >= 2 && new Set(cartes).size === 1, "hauteurs différentes : " + cartes);
    const defile = await page.locator("div.h-\\[28rem\\] ul").evaluateAll((els) => els.some((u) => u.scrollHeight > u.clientHeight && getComputedStyle(u).overflowY === "auto"));
    ok(defile, "aucune liste ne défile à l'intérieur de sa carte");
    await page.screenshot({ path: `${SHOTS}/admin-parametres.png` });
  });

  for (const id of ids) await ctx.request.delete(`/api/admin/notifications/${id}`);
  await ctx.close();
}

console.log("\nBoutons flottants et débordement horizontal (bureau et mobile)");
{
  const cree = { id: await creerEpreuveRiche(`Mathématiques appliquées ${RUN}`, "2036") };

  // Position du bloc `fixed` (l'élément lui-même ou son conteneur fixe), dans la zone VISIBLE de la fenêtre.
  const position = (loc) => loc.evaluate((e) => {
    const f = getComputedStyle(e).position === "fixed" ? e : e.closest(".fixed");
    if (!f) return { fixe: false };
    const r = f.getBoundingClientRect(), d = document.documentElement;
    return { fixe: true, x: Math.round(r.x), y: Math.round(r.y), visible: r.x >= 0 && r.y >= 0 && r.right <= d.clientWidth + 1 && r.bottom <= d.clientHeight + 1 };
  });
  const resteFixe = async (page, loc, nom) => {
    await page.evaluate(() => document.scrollingElement.scrollTo(0, 0));
    const avant = await position(loc);
    const defile = await page.evaluate(async () => { const r = document.scrollingElement; r.scrollTo(0, r.scrollHeight); await new Promise((res) => setTimeout(res, 300)); return r.scrollTop; });
    const apres = await position(loc);
    ok(defile > 0, `${nom} : la page ne défile pas, le test serait sans objet`);
    ok(avant.fixe && avant.visible && apres.visible, `${nom} : hors de la zone visible ${JSON.stringify({ avant, apres })}`);
    ok(avant.x === apres.x && avant.y === apres.y, `${nom} : a bougé avec le défilement ${JSON.stringify({ avant, apres })}`);
  };
  const attendreChargement = async (page) => {
    await page.waitForFunction(() => !document.querySelector(".skeleton, [aria-busy='true']"), null, { timeout: 15000 });
    await page.waitForTimeout(300);
  };
  const deborde = (page) => page.evaluate(() => { const d = document.documentElement; return innerWidth !== d.clientWidth || d.scrollWidth > d.clientWidth; });

  const VUES = [["bureau", { viewport: { width: 1280, height: 900 } }], ["mobile", { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }]];
  for (const [vue, options] of VUES) {
    const ctx = await nouveauContexte(options);
    await connecterAdmin(ctx);
    const page = await ctx.newPage();
    const ongletAdmin = (valeur) => page.locator("select").first().selectOption(valeur, { force: true }); // le <select> est masqué sur grand écran

    await test(`${vue} › lecteur : A−/A+ et lanceur de l'assistant restent fixes et visibles après défilement de la page`, async () => {
      await page.goto(`/epreuve/${cree.id}`);
      await page.getByRole("button", { name: "Agrandir le texte" }).waitFor({ timeout: 15000 });
      await resteFixe(page, page.getByRole("button", { name: "Agrandir le texte" }), "A−/A+");
      await resteFixe(page, page.getByRole("button", { name: "Ouvrir Tuteur IA Prep" }), "lanceur de l'assistant élève");
    });

    await test(`${vue} › admin : lanceur « Ouvrir l'assistant admin » (Épreuves) et bouton « Assistant » (autres onglets) restent fixes et visibles`, async () => {
      await page.goto("/admin");
      const lanceur = page.getByRole("button", { name: "Ouvrir l'assistant admin" });
      await lanceur.waitFor({ timeout: 15000 });
      await resteFixe(page, lanceur, "lanceur de l'assistant d'épreuve");
      await ongletAdmin("utilisateurs");
      const global = page.getByRole("button", { name: "Assistant", exact: true });
      await global.waitFor({ timeout: 10000 });
      await resteFixe(page, global, "bouton Assistant global");
    });

    if (vue === "mobile") {
      await test("mobile › catalogue : la barre d'onglets du bas reste fixe et visible", async () => {
        await page.goto("/catalogue");
        await attendreChargement(page);
        const barre = page.getByRole("navigation", { name: "Navigation principale" });
        await barre.waitFor({ timeout: 15000 });
        await resteFixe(page, barre, "barre d'onglets");
      });
    }

    await test(`${vue} › aucune page ne déborde horizontalement (sinon la fenêtre s'élargit et les boutons fixes sortent de l'écran)`, async () => {
      const fautives = [];
      for (const url of ["/", "/secondaire/terminale", "/catalogue", "/abonnement", "/calendrier", "/profil", "/aide", "/a-propos", `/epreuve/${cree.id}`]) {
        await page.goto(url);
        await attendreChargement(page);
        if (await deborde(page)) fautives.push(url);
      }
      const visiteur = await (await nouveauContexte(options)).newPage();
      await visiteur.goto(`/epreuve/${cree.id}`);
      await attendreChargement(visiteur);
      if (await deborde(visiteur)) fautives.push("épreuve (visiteur)");
      await page.goto("/admin");
      for (const valeur of await page.locator("select").first().locator("option").evaluateAll((o) => o.map((x) => x.value))) {
        await ongletAdmin(valeur);
        await attendreChargement(page);
        if (await deborde(page)) fautives.push(`admin › ${valeur}`);
      }
      ok(!fautives.length, "débordement horizontal : " + fautives.join(", "));
    });
    await ctx.close();
  }
}

await browser.close();
const echecs = resultats.filter((r) => !r[0]);
console.log(`\n${resultats.length - echecs.length}/${resultats.length} scénarios réussis`);
process.exit(echecs.length ? 1 : 0);
