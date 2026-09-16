# Plan : Support multi-sujets par épreuve

## Objectif
Une épreuve peut posséder plusieurs sujets (chacun avec son propre corrigé optionnel).
- **Admin** : tab toggle avec "Sujet 1" par défaut, bouton "+" pour ajouter des sujets
- **Lecteur** : tab toggle pour switcher entre les sujets

---

## 1. Backend — Modèle de données

### `backend/app/db_models.py`

**`EpreuveFileORM`** — ajouter `sujet_index` :
```python
sujet_index = Column(Integer, nullable=False, default=0)
```
- Contrainte unique : `(epreuve_id, cible, format, sujet_index)` pour les docs md
- Default 0 → compatibilité totale avec les données existantes

**`EpreuveORM.corrige_disponible`** — adapter pour le multi-sujet :
```python
@property
def corrige_disponible(self) -> bool:
    return any(f.cible == "corrige" and f.format == "md" for f in self.files_rel)

@property
def nb_sujets(self) -> int:
    sujets = {f.sujet_index for f in self.files_rel if f.cible == "sujet" and f.format == "md"}
    return max(len(sujets), 1)  # au moins 1 sujet
```

---

## 2. Backend — Stockage fichiers

### `backend/app/core/epreuve_files.py`

**`document_key()`** — ajouter paramètre `sujet_index` :
```python
def document_key(epreuve, cible, sujet_index=0):
    if cible == "sujet" and sujet_index > 0:
        return f"epreuves/{epreuve.niveau}/{epreuve.annee}/{epreuve.id}/sujet_{sujet_index}.md"
    return f"epreuves/{epreuve.niveau}/{epreuve.annee}/{epreuve.id}/{cible}.md"
```
- index=0 → `sujet.md` (rétrocompatible)
- index>0 → `sujet_1.md`, `sujet_2.md`, etc.

**`get_document()`** — ajouter filtre `sujet_index` :
```python
def get_document(db, epreuve_id, cible, sujet_index=0):
    return db.query(EpreuveFileORM).filter(
        EpreuveFileORM.epreuve_id == epreuve_id,
        EpreuveFileORM.cible == cible,
        EpreuveFileORM.format == DOCUMENT_FORMAT,
        EpreuveFileORM.sujet_index == sujet_index,
    ).one_or_none()
```

**`read_document_content()`** — ajouter `sujet_index`

**`write_document()`** — ajouter `sujet_index`, utiliser la bonne clé

**`save_image()`** — ne PAS ajouter `sujet_index` (les images restent par cible sujet/corrige, pas par index de sujet)

---

## 3. Backend — Modèles Pydantic

### `backend/app/models.py`

Ajouter :
```python
class SujetOut(BaseModel):
    index: int
    contenu_markdown: str
    corrige_markdown: Optional[str] = ""
    corrige_disponible: bool

class SujetIn(BaseModel):
    index: int
    contenu_markdown: str = ""
    corrige_markdown: Optional[str] = None
```

Modifier `EpreuveDetail` :
```python
class EpreuveDetail(EpreuveListItem):
    contenu_markdown: str          # backward compat (sujet index 0)
    corrige_markdown: Optional[str] = ""  # backward compat
    assets: list[EpreuveFileOut] = []
    sujets: list[SujetOut] = []    # nouveau : tous les sujets
    nb_sujets: int = 1
```

Modifier `EpreuveIn` et `EpreuveUpdate` :
```python
sujets: Optional[list[SujetIn]] = None  # remplace contenu_markdown/corrige_markdown si fourni
```

---

## 4. Backend — Migration

### Nouveau fichier : `backend/scripts_dev/migrate_multi_sujets.py`

Script idempotent qui :
1. Ajoute la colonne `sujet_index` à `epreuve_files` (DEFAULT 0)
2. Crée l'index unique si absent
3. Renomme les fichiers `sujet.md` → `sujet_0.md` dans le stockage (pour les épreuves qui ont déjà un sujet_index=0, le fichier reste `sujet.md` — pas de renommage nécessaire car `document_key(0)` retourne `sujet.md`)

---

## 5. Backend — Routes admin

### `backend/app/routers/admin_epreuves.py`

**`admin_get_epreuve()`** — retourner le tableau `sujets` :
```python
sujets = []
for idx in sorted({f.sujet_index for f in e.files_rel if f.format == "md"}):
    sujets.append({
        "index": idx,
        "contenu_markdown": read_document_content(db, e.id, "sujet", idx),
        "corrige_markdown": read_document_content(db, e.id, "corrige", idx),
        "corrige_disponible": get_document(db, e.id, "corrige", idx) is not None,
    })
```

**`admin_create_epreuve()`** — supporter le champ `sujets` :
- Si `sujets` fourni → itérer et écrire chaque sujet/corrige
- Sinon → fallback sur `contenu_markdown`/`corrige_markdown` (backward compat)

**`admin_update_epreuve()`** — supporter `sujets` :
- Si `sujets` fourni → écrire/supprimer les sujets manquants
- Sinon → fallback sur `contenu_markdown`/`corrige_markdown`

**`admin_publish()`** — vérifier qu'au moins un sujet existe (index 0 ou n'importe lequel)

**`admin_list_epreuves()`** — ajouter `nb_sujets` au retour

---

## 6. Backend — Route publique

### `backend/app/routers/epreuves.py`

**`get_epreuve()`** — construire le tableau `sujets` dans `EpreuveDetail` :
```python
sujets = []
for idx in sorted({f.sujet_index for f in e.files_rel if f.format == "md"}):
    sujets.append(SujetOut(
        index=idx,
        contenu_markdown=sign_image_urls(read_document_content(db, e.id, "sujet", idx), e),
        corrige_markdown=sign_image_urls(read_document_content(db, e.id, "corrige", idx), e),
        corrige_disponible=get_document(db, e.id, "corrige", idx) is not None,
    ))
```

---

## 7. Frontend — Types

### `frontend/src/api/types.ts`

Ajouter :
```typescript
export interface SujetContent {
  index: number;
  contenu_markdown: string;
  corrige_markdown: string;
  corrige_disponible: boolean;
}

export interface EpreuveDetail extends EpreuveListItem {
  contenu_markdown: string;
  corrige_markdown: string;
  assets: EpreuveFile[];
  sujets: SujetContent[];
  nb_sujets: number;
}
```

---

## 8. Frontend — Admin panel (EpreuvesPanel.tsx)

### `frontend/src/pages/admin/shared.tsx`

Ajouter interface `SujetFormData` dans `EpreuveForm` :
```typescript
export interface SujetFormData {
  index: number;
  contenu_markdown: string;
  corrige_markdown: string;
}

export interface EpreuveForm {
  // ... champs existants ...
  sujets: SujetFormData[];
}
```

Modifier `EMPTY_FORM` :
```typescript
sujets: [{ index: 0, contenu_markdown: "", corrige_markdown: "" }],
```

### `frontend/src/pages/admin/EpreuvesPanel.tsx`

**Nouvel état** :
- `sujetActif: number` (index du sujet sélectionné, défaut 0)
- Les previews `sujetPreview`/`corrigePreview` deviennent des Record<number, boolean>

**`fetchDetail()`** — remplir `form.sujets` depuis `detail.sujets`

**`save()`** — envoyer `sujets` dans le payload

**Ajout/suppression de sujets** :
```typescript
function addSujet() {
  const nextIndex = Math.max(...form.sujets.map(s => s.index)) + 1;
  setForm(f => ({
    ...f,
    sujets: [...f.sujets, { index: nextIndex, contenu_markdown: "", corrige_markdown: "" }],
  }));
  setSujetActif(nextIndex);
}

function removeSujet(index: number) {
  setForm(f => ({
    ...f,
    sujets: f.sujets.filter(s => s.index !== index),
  }));
  setSujetActif(0);
}
```

**Onglets sujets** (au-dessus des ContentBlocks) :
```tsx
<div role="tablist" className="flex items-center gap-1 rounded-full border border-ink-soft/20 p-1">
  {form.sujets.map((s, i) => (
    <button key={s.index} role="tab" aria-selected={sujetActif === s.index}
      onClick={() => setSujetActif(s.index)}
      className={`... ${sujetActif === s.index ? "bg-ink text-paper" : ""}`}>
      Sujet {i + 1}
      {form.sujets.length > 1 && (
        <X size={12} onClick={(e) => { e.stopPropagation(); removeSujet(s.index); }} />
      )}
    </button>
  ))}
  <button onClick={addSujet} className="...">+</button>
</div>
```

**ContentBlocks** — afficher ceux du sujet actif :
```tsx
const sujetActifData = form.sujets.find(s => s.index === sujetActif) ?? form.sujets[0];

<ContentBlock
  title={`Sujet ${sujetActif + 1}`}
  markdown={sujetActifData.contenu_markdown}
  onChange={(v) => updateSujet(sujetActif, "contenu_markdown", v)}
  ...
/>
<ContentBlock
  title={`Corrigé ${sujetActif + 1} (optionnel)`}
  markdown={sujetActifData.corrige_markdown}
  onChange={(v) => updateSujet(sujetActif, "corrige_markdown", v)}
  ...
/>
```

---

## 9. Frontend — Viewer (ViewerPage.tsx)

### `frontend/src/pages/ViewerPage.tsx`

**Type** : `type Onglet = "sujet" | "corrige"` (pas de changement)

**Nouvel état** : `sujetActif: number` (défaut 0)

**Contenu actif** :
```typescript
const sujetActifData = epreuve.sujets?.find(s => s.index === sujetActif) ?? {
  contenu_markdown: epreuve.contenu_markdown,
  corrige_markdown: epreuve.corrige_markdown,
  corrige_disponible: epreuve.corrige_disponible,
};

const contenuActif = onglet === "sujet"
  ? sujetActifData.contenu_markdown
  : sujetActifData.corrige_markdown;
```

**Onglets** — deux niveaux si > 1 sujet :
```tsx
{/* Onglet sujet (si > 1 sujet) */}
{epreuve.sujets && epreuve.sujets.length > 1 && (
  <div role="tablist" aria-label="Sujets">
    {epreuve.sujets.map(s => (
      <button key={s.index} role="tab" aria-selected={sujetActif === s.index}
        onClick={() => { setSujetActif(s.index); setOnglet("sujet"); }}>
        Sujet {s.index + 1}
      </button>
    ))}
  </div>
)}

{/* Onglet sujet/corrige (si corrige disponible pour le sujet actif) */}
{sujetActifData.corrige_disponible && (
  <div role="tablist" aria-label="Contenu">
    <button onClick={() => setOnglet("sujet")}>Sujet</button>
    <button onClick={() => setOnglet("corrige")}>Corrigé</button>
  </div>
)}
```

**Raccourcis clavier** — adapter S/C pour le sujet actif :
```typescript
if (k === "s" && epreuve.sujets?.some(s => s.index === sujetActif && s.contenu_markdown))
  setOnglet("sujet");
else if (k === "c" && sujetActifData.corrige_disponible)
  setOnglet("corrige");
```

---

## 10. Import massif (import_service.py)

Ne pas modifier pour l'instant — l'import continue de créer 1 sujet par épreuve. Le multi-sujet est une fonctionnalité admin.

---

## 11. Checklist de vérification

- [x] Migration exécutable sans erreur (`backend/scripts_dev/migrate_multi_sujets.py` idempotent, aussi lancé au démarrage dans `main.py`)
- [x] Épreuves existantes affichées correctement (backward compat — index 0 à plat `sujet.md`/`corrige.md`)
- [x] Admin : création épreuve avec 1 sujet (comportement identique)
- [x] Admin : ajout sujet 2, 3… avec onglets
- [x] Admin : suppression d'un sujet (jamais le dernier)
- [x] Admin : enregistrement avec multi-sujets
- [x] Admin : publication avec multi-sujets (exige au moins un sujet, corrigé optionnel)
- [x] Lecteur : affichage sujet 1 par défaut
- [x] Lecteur : switch entre sujets via onglets
- [x] Lecteur : corrigé accessible par sujet
- [x] Raccourcis clavier S/C fonctionnent (sur le sujet actif)
- [ ] Notes personnelles liées au bon sujet (sélection basée sur la zone du sujet actif — à vérifier manuellement)
- [ ] Assistant IA utilise le bon sujet comme contexte (sujet principal envoyé à plat — OK ; multi-sujets complet non exposé)
- [x] Tests backend passent (117 pytest)
- [x] Typecheck frontend + tests passent (tsc -b, 55 vitest)

### Écarts assumés vs plan initial
- Pas de contrainte unique `(epreuve_id, cible, format, sujet_index)` : l'unicité est garantie par l'écriture logique (`get_document`/`write_document`).
- Pas de renommage `sujet_0.md` : index 0 garde ses clés historiques (`sujet.md`/`corrige.md`).
- Images sujets conservées par cible (sujet/corrigé), sans index — la balise rejoint le sujet actif à l'insertion.
- Assistant admin : le prompt backend lit toujours `contenu_markdown`/`corrige_markdown` à plat (sujet principal) — les sujets supplémentaires ne lui sont pas (encore) exposés.
- Import massif non modifié : l'import crée toujours 1 sujet (index 0).
