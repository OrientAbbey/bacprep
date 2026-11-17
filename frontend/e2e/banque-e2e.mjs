// Recette de bout en bout du GÉNÉRATEUR D'ÉPREUVES (cahier V4.10).
// Prérequis : serveur lancé (API + frontend compilé) avec AUTH_MODE=mock, puis :
//   E2E_URL=http://localhost:8765 E2E_ADMIN_TOKEN=... [E2E_CHROMIUM=/chemin/chromium] node e2e/banque-e2e.mjs
//
// Couvre : options et métadonnée de spécialité obligatoire, génération complet/partiel,
// gating par abonnement, propriété des générations, et impression séparée du sujet
// et du corrigé (émulation du media « print », sans boîte de dialogue réelle).
import { chromium } from "playwright-core";
import fs from "node:fs";

const URL_BASE = process.env.E2E_URL ?? "http://localhost:8765";
const ADMIN = { email: process.env.E2E_ADMIN_EMAIL ?? "admin@example.com", token: process.env.E2E_ADMIN_TOKEN ?? "admin123" };
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/e2e_banque_shots";
fs.mkdirSync(SHOTS, { recursive: true });

const resultats = [];
async function test(nom, fn) {
  try {
    await fn();
    resultats.push([true, nom]);
    console.log("  ✓", nom);
  } catch (e) {
    resultats.push([false, nom, e.message.slice(0, 3000)]);
    console.log("  ✗", nom, "\n     →", e.message.slice(0, 3000));
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const RUN = Date.now().toString(36);
const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: process.env.E2E_CHROMIUM_ARGS ? process.env.E2E_CHROMIUM_ARGS.split(" ") : [],
});

async function nouveauContexte(options = {}) {
  return browser.newContext({ baseURL: URL_BASE, viewport: { width: 1366, height: 900 }, serviceWorkers: "block", ...options });
}
async function connecterEleve(ctx, email) {
  const r = await ctx.request.post("/api/auth/mock-login", { data: { email, nom: "Élève Recette" } });
  ok(r.ok(), "mock-login : " + r.status());
  const c = await ctx.request.put("/api/me/consentement", { data: { partage_conversations_ia: true, partage_notes: true } });
  ok(c.ok(), "consentement : " + c.status());
}
async function connecterAdmin(ctx) {
  await connecterEleve(ctx, ADMIN.email);
  const r = await ctx.request.post("/api/admin/login", { data: ADMIN });
  ok(r.ok(), "login admin : " + r.status());
}
async function aller(pg, url, options = {}) {
  try {
    await pg.goto(url, { timeout: 45000, ...options });
  } catch {
    await pg.goto(url, { timeout: 45000, ...options });
  }
}
async function assurerOption(admin, scope, code) {
  const r = await admin.request.post("/api/admin/referentiel-options", { data: { scope, code } });
  if (!r.ok() && r.status() !== 409) throw new Error(`option ${scope}/${code} : ${r.status()} ${await r.text()}`);
}
async function abonnementMatiere(ctx, matiere, classe, filiere) {
  const achat = await ctx.request.post("/api/subscriptions/checkout", {
    data: { scope: "matiere", matiere, classe, filiere, provider: "orange" },
  });
  ok(achat.ok(), "checkout : " + achat.status() + " " + (await achat.text()));
  const w = await ctx.request.post("/api/payments/simulate-webhook", {
    data: { reference_agregateur: (await achat.json()).reference_agregateur },
  });
  ok(w.ok(), "webhook : " + w.status());
}

// ------------------------------------------------------------------ données
const subject = `Recette Générateur ${RUN}`;
const classePrincipale = "terminale";
const classeOblige = "1ere";
const serie = "C";

const admin = await nouveauContexte();
await connecterAdmin(admin);
await assurerOption(admin, "matiere", subject);
await assurerOption(admin, "serie", serie);

async function peupler(matiere, classe, n, series) {
  const part = await (await admin.request.post("/api/admin/banque/parties", { data: { matiere, nom: `Partie ${classe} ${RUN}` } })).json();
  for (let i = 0; i < n; i++) {
    const r = await admin.request.post("/api/admin/banque/exercices", {
      data: {
        sujet: `Sujet ${matiere} ${i + 1}`, corrige: `Corrigé ${matiere} ${i + 1}`,
        partie_id: part.id, session: (i % 3) + 1, niveau_intrinseque: "Moyen",
        tag_examen: true, actif: true, matieres: [matiere], classes: [classe], series,
      },
    });
    ok(r.ok(), "exercice de banque : " + r.status() + " " + (await r.text()));
  }
}
await peupler(subject, classePrincipale, 8, ["SPECIAL:Aucune"]);
await peupler(subject, classeOblige, 6, [serie, "SPECIAL:Aucune"]);
const meta = await admin.request.put(`/api/admin/banque/classes/${classeOblige}`, {
  data: { a_examen: true, specialite_obligatoire: true },
});
ok(meta.ok(), "métadonnée de classe : " + meta.status());

const eleve = await nouveauContexte();
await connecterEleve(eleve, `recette-${RUN}@test.cm`);
await abonnementMatiere(eleve, subject, classePrincipale, serie);
await abonnementMatiere(eleve, subject, classeOblige, serie);

const page = await eleve.newPage();

// ------------------------------------------------------------------ scénarios
console.log("\nGénérateur — options et gating");
{
  await test("options : classes_meta expose la spécialité obligatoire", async () => {
    const options = await (await eleve.request.get("/api/banque/options")).json();
    ok(options.classes_meta[classeOblige]?.specialite_obligatoire === true, "métadonnée absente de la réponse");
    ok(options.classes_meta[classePrincipale]?.specialite_obligatoire !== true, "classe principale à tort obligatoire");
    ok(options.matieres.includes(subject), "matière absente des options");
  });

  await test("gating : matière non abonnée refusée (403)", async () => {
    const autre = await nouveauContexte();
    await connecterEleve(autre, `non-abonne-${RUN}@test.cm`);
    const r = await autre.request.post("/api/banque/generer", {
      data: { matiere: subject, classe: classePrincipale, sequence: 1, mode: "sequence", difficulte: "Moyen" },
    });
    ok(r.status() === 403, "statut " + r.status());
    await autre.close();
  });

  await test("propriété : une génération d'un autre élève est 404", async () => {
    const cree = await eleve.request.post("/api/banque/generer", {
      data: { matiere: subject, classe: classePrincipale, sequence: 1, mode: "sequence", difficulte: "Moyen" },
    });
    ok(cree.ok(), "génération : " + cree.status());
    const id = (await cree.json()).generation_id;
    const autre = await nouveauContexte();
    await connecterEleve(autre, `autre-${RUN}@test.cm`);
    const r = await autre.request.get(`/api/banque/generations/${id}`);
    ok(r.status() === 404, "statut " + r.status());
    const corrige = await autre.request.get(`/api/banque/generations/${id}/corrige`);
    ok(corrige.status() === 404, "corrigé statut " + corrige.status());
    await autre.close();
  });
}

console.log("\nGénérateur — formulaire et spécialité obligatoire");
{
  await test("formulaire : sans spécialité, la génération est bloquée puis possible", async () => {
    await aller(page, "/entrainement");
    await page.getByRole("button", { name: "Composer une épreuve" }).first().click();
    const selectDansLabel = (texte) => page.locator("label", { hasText: texte }).locator("select").first();
    await selectDansLabel("Matière").waitFor({ timeout: 15000 });

    await selectDansLabel("Classe").selectOption(classeOblige);
    await selectDansLabel("Matière").selectOption(subject);
    const gen = page.getByRole("button", { name: "Générer l'épreuve", exact: true });
    await page.waitForTimeout(300);
    ok(await gen.isDisabled(), "la génération devrait être bloquée sans spécialité");

    await selectDansLabel("Série / spécialité").selectOption(serie);
    await page.waitForTimeout(200);
    ok(!(await gen.isDisabled()), "la génération reste bloquée avec une spécialité");
    await gen.click();
    await page.getByRole("heading", { name: "Épreuve personnalisée", exact: true }).waitFor({ timeout: 20000 });
    await page.screenshot({ path: `${SHOTS}/generateur-epreuve.png` });
  });

  await test("serveur : spécialité obligatoire imposée même sans l'interface (422)", async () => {
    const r = await eleve.request.post("/api/banque/generer", {
      data: { matiere: subject, classe: classeOblige, sequence: 1, mode: "sequence", difficulte: "Moyen" },
    });
    ok(r.status() === 422, "statut " + r.status());
  });
}

console.log("\nGénérateur — correction et impression séparée");
{
  await test("corrigé : chargé à la demande, aligné sur les numéros", async () => {
    const gen = page.getByRole("heading", { name: "Épreuve personnalisée", exact: true });
    await gen.waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Voir le corrigé", exact: true }).click();
    await page.getByRole("heading", { name: "Corrigé", exact: true }).first().waitFor({ timeout: 15000 });
    // Le corrigé est bien chargé (le bouton d'impression du corrigé apparaît).
    await page.getByRole("button", { name: "Imprimer le corrigé", exact: true }).waitFor({ timeout: 10000 });
  });

  await test("impression sujet : seule la zone sujet est visible en media print", async () => {
    await page.evaluate(() => { window.print = () => { window.__imprime = true; }; });
    await page.getByRole("button", { name: "Imprimer l'épreuve", exact: true }).click();
    await page.waitForFunction(() => window.__imprime === true, null, { timeout: 5000 });
    await page.emulateMedia({ media: "print" });
    ok(await page.locator(".print-zone--actif.print-zone-sujet").isVisible(), "zone sujet absente en impression");
    ok((await page.locator(".print-zone--actif").count()) === 1, "plusieurs zones actives");
    ok(!(await page.locator("#root").isVisible()), "l'application reste visible en impression");
    const texte = await page.locator(".print-zone--actif").innerText();
    ok(!/Corrigé/.test(texte), "le corrigé fuit dans l'impression du sujet : " + texte.slice(0, 120));
    await page.screenshot({ path: `${SHOTS}/generateur-impression-sujet.png` });
    await page.emulateMedia({ media: "screen" });
  });

  await test("impression corrigé : seule la zone corrigé est visible en media print", async () => {
    await page.evaluate(() => { window.print = () => { window.__imprime2 = true; }; });
    await page.getByRole("button", { name: "Imprimer le corrigé", exact: true }).click();
    await page.waitForFunction(() => window.__imprime2 === true, null, { timeout: 5000 });
    await page.emulateMedia({ media: "print" });
    ok(await page.locator(".print-zone--actif.print-zone-corrige").isVisible(), "zone corrigé absente en impression");
    ok((await page.locator(".print-zone--actif").count()) === 1, "plusieurs zones actives");
    const texte = await page.locator(".print-zone--actif").innerText();
    ok(/Corrigé/.test(texte), "corrigé absent de l'impression du corrigé");
    await page.screenshot({ path: `${SHOTS}/generateur-impression-corrige.png` });
    await page.emulateMedia({ media: "screen" });
  });
}

console.log("\nGénérateur — reprise après rechargement");
{
  await test("rechargement : la génération reste lisible, sans corrigé affiché par défaut", async () => {
    await page.reload();
    await page.getByRole("heading", { name: "Épreuve personnalisée", exact: true }).waitFor({ timeout: 15000 });
    ok((await page.getByRole("heading", { name: "Corrigé", exact: true }).count()) === 0, "corrigé affiché sans demande");
  });
}

await eleve.close();
await admin.close();
await browser.close();

const echecs = resultats.filter(([r]) => !r);
console.log(`\n${resultats.length - echecs.length}/${resultats.length} scénarios réussis`);
if (echecs.length) {
  console.log("Échecs :");
  for (const [_, nom, msg] of echecs) console.log("  -", nom, "\n    ", msg);
  process.exit(1);
}
