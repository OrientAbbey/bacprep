# Guide d'intégration du paiement réel (Notch Pay / Monetbil)

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
