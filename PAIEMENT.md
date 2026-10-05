# Paiement — ÉTAT : EN PAUSE (documentation uniquement)

> **Décision (octobre 2026)** : l'encaissement réel est mis en pause. Aucun code de
> paiement réel n'a été écrit. Ce qui existe reste inchangé : le checkout crée un
> paiement `pending`, `DEMO_MODE` + `POST /api/payments/simulate-webhook` simulent la
> confirmation, et le webhook signé « maison » reste fermé (503) tant que
> `PAYMENT_WEBHOOK_SECRET` est vide. **En production (`DEMO_MODE=false`), personne ne peut
> donc acheter** : seules les épreuves gratuites sont accessibles. Les formules
> (onglet admin « Formules ») sont déjà éditables : elles fixent prix et durée au checkout.

## Piste retenue pour la reprise : Fapshi (sans entreprise, sans carte)

Passerelle camerounaise (MTN MoMo et Orange Money). Informations relevées sur la
documentation publique en octobre 2026 — **à revérifier sur https://docs.fapshi.com avant
d'implémenter** :

- **Compte** : activation sur dashboard.fapshi.com avec l'option « activité non légalement
  enregistrée » (pièce d'identité + selfie). **Fapshi décide d'accepter ou non le compte** ;
  rien n'est garanti. Pas de carte bancaire requise.
- **Frais** : 3 % par encaissement, 0 % sur les retraits vers MoMo/Orange Money, sans
  abonnement ; montant minimum 100 FCFA (les prix de 400 FCFA et plus passent ; 400 FCFA
  rapportent environ 388 FCFA).
- **Clés** : Developers › New Service → `apiuser` + `apikey` (Sandbox puis Live).
  **Ne pas activer la liste d'IP autorisées** (Render gratuit n'a pas d'IP fixe).
- **Webhook** : URL `https://<service>.onrender.com/api/payments/webhook` + un secret au choix.

### Conception prévue (≈ 25 lignes nettes de backend)

1. `core/fapshi.py` (≈ 35 lignes, `httpx` déjà installé) : `initier(montant, external_id,
   redirect_url)` → `link` + `transId` ; `statut(trans_id)`.
2. `checkout` : appelle « Initiate Pay » (page de paiement hébergée par Fapshi), range le
   `transId` dans `reference_agregateur` (colonne unique existante) et renvoie `link` ; le
   frontend redirige.
3. **Règle de sécurité unique : le contenu du webhook n'est jamais cru.** Webhook et page de
   retour ne sont que des déclencheurs : le serveur interroge `GET /payment-status/{transId}` et
   confirme **seulement si** statut = `SUCCESSFUL`, montant = montant attendu et `externalId`
   = identifiant du paiement, puis appelle `_confirm_payment` (déjà idempotent).
4. Fapshi n'envoie le webhook **qu'une seule fois** et Render gratuit peut dormir plus d'une
   minute : prévoir `GET /api/payments/{id}` (propriétaire seulement) appelé par la page de
   retour `/abonnement?paiement=ID` toutes les 10 s (limite Fapshi : 6 requêtes/min par
   transaction) + un bouton « Vérifier mon paiement » dans le profil (paiements de moins de 24 h).
5. Poser `start_date` / `end_date` de l'abonnement **à la confirmation** (aujourd'hui à la
   création du checkout : un paiement tardif raccourcit l'abonnement).
6. Supprimer la signature HMAC maison, l'horodatage anti-rejeu et `WEBHOOK_MAX_AGE_SECONDS`.
7. Variables : `FAPSHI_API_USER`, `FAPSHI_API_KEY`, `FAPSHI_WEBHOOK_SECRET`, `FAPSHI_BASE_URL`
   (sandbox par défaut) — à ajouter à `.env.example` (le test `test_env_example` l'exige).
8. Tests : faux client Fapshi (succès, montant falsifié, `externalId` étranger, webhook rejoué).

Si Fapshi refuse le compte, seul `core/fapshi.py` change pour un autre agrégateur.

---

# (Archive) Guide d'intégration du paiement réel (Notch Pay / Monetbil)

> Ancien guide, antérieur à la décision ci-dessus. Notch Pay exige une vérification
> d'entreprise (KYC) : il ne convient pas sans entreprise.

> **Avertissement important :** les détails d'API ci-dessous (endpoints,
> noms de champs, format de signature) reflètent la documentation publique
> au moment de la rédaction de ce guide. Les agrégateurs de paiement font
> évoluer leurs API sans nécessairement prévenir tous leurs intégrateurs.
> **Revérifie systématiquement chaque détail sur la documentation officielle
> au moment de l'implémentation, plutôt que de suivre ce guide aveuglément.**

## Pourquoi Notch Pay en primaire, Monetbil en repli

Voir l'étude comparative complète en section 10.1 du
`CAHIER_DES_CHARGES.md`. En résumé : Notch Pay a une tarification publique
simple (2% par encaissement, aucun frais fixe) et couvre Orange Money +
MTN MoMo via une seule API. Monetbil est le repli recommandé si
l'enregistrement d'entreprise requis par Notch Pay n'est pas encore
finalisé.

## Étapes d'intégration — Notch Pay

1. **Créer un compte marchand** sur [notchpay.co](https://notchpay.co) et
   compléter la vérification d'entreprise (KYC).
2. **Récupérer les clés API** dans le tableau de bord (clé publique et clé
   privée, environnement sandbox puis production).
3. **Initialiser un paiement** : remplacer la simulation actuelle
   (`POST /api/subscriptions/checkout`, qui crée directement un paiement
   `pending` avec une référence `SIMULATED-...`) par un véritable appel à
   l'API Notch Pay pour créer une transaction, en lui transmettant le montant,
   la devise (XAF), et une URL de callback.
4. **Rediriger l'utilisateur** vers l'URL de paiement retournée par Notch
   Pay (ou déclencher un prompt USSD selon le flux choisi).
5. **Recevoir le webhook de confirmation** sur un nouvel endpoint (ex.
   `POST /api/payments/notchpay-webhook`), remplaçant
   `POST /api/payments/simulate-webhook`.
6. **Vérifier la signature du webhook** (Notch Pay signe ses webhooks —
   consulter la documentation pour l'algorithme et l'en-tête exacts au
   moment de l'implémentation) avant de faire confiance à son contenu.
7. **Conserver l'idempotence déjà en place** : le code actuel déduplique
   déjà par `reference_agregateur` (unique en base) — ce mécanisme reste
   valable, il suffit de brancher la vraie référence Notch Pay dessus.

## Repli — Monetbil

Si l'ouverture d'un compte Notch Pay bute sur l'exigence d'enregistrement
d'entreprise, [Monetbil](https://www.monetbil.com) ne demande pas cette
formalité pour démarrer. L'intégration suit le même schéma général
(création de paiement → redirection/USSD → webhook signé → activation de
l'abonnement), avec un format d'API propre à Monetbil à consulter dans sa
documentation.

## Checklist avant mise en production

- [ ] Clés API en production (pas sandbox) configurées comme variables
      d'environnement, jamais commitées dans le dépôt.
- [ ] Vérification de signature du webhook implémentée et testée (y
      compris avec une signature invalide, qui doit être rejetée).
- [ ] Idempotence testée avec un webhook rejoué manuellement.
- [ ] Montants affichés au client et montants réellement débités
      vérifiés identiques (attention aux frais éventuellement répercutés).
- [ ] Page d'échec de paiement gérée explicitement (statut `failed`), pas
      seulement le cas `confirmed`.
- [ ] Taux de commission reconfirmés sur le tableau de bord de
      l'agrégateur (ils évoluent et sont parfois négociables à volume).
- [ ] Test de bout en bout en environnement sandbox avant le premier
      paiement réel.
