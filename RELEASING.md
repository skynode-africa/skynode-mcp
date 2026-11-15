# Publier une version

La publication de `@skynode-africa/mcp` sur npm est **entièrement manuelle**. La CI
(`.github/workflows/ci.yml`, job `verify`) vérifie la qualité sur chaque PR et sur chaque
push vers `main` — types, tests, build, validité de la sonde, refus de démarrage sans
`SKYNODE_TOKEN` — mais **ne publie jamais**. Aucun changeset, aucune release automatisée.

Chaque version suit donc les étapes ci-dessous, dans l'ordre.

## 1. Bumper la version — aux **deux** endroits

La version est écrite à deux endroits qui doivent toujours coïncider :

- `package.json` → champ `version` (le paquet npm) ;
- `src/index.ts` → `new McpServer({ name: "skynode", version: "…" })`, la version que le
  serveur annonce au client lors du handshake MCP.

Si les deux divergent, le serveur publié annonce une version périmée. Rien ne les lie
automatiquement : les changer ensemble est manuel.

```bash
# dans package.json, sans créer de tag git (le tag se pose après publication, étape 5)
npm version patch --no-git-tag-version   # 0.4.0 → 0.4.1
```

> ⚠️ `npm version` **reformate** `package.json` : il déballe les objets compacts
> (`bin`, `files`, `engines`) en multi-lignes. Restaurer leur format d'origine sur une seule
> ligne pour que le diff ne porte que sur la version.

Puis reporter la **même** version à la main dans `src/index.ts`.

Choix du niveau (`patch` / `minor` / `major`) : les libellés d'état et messages du serveur
sont de la **sortie runtime lue par les agents clients**. Un changement de leur texte est
donc au minimum un `patch`, jamais un simple « docs » sans publication.

## 2. Vérifier localement

Ce que la CI exigera, joué en local avant d'ouvrir la PR :

```bash
pnpm typecheck      # tsconfig.json + tsconfig.test.json
pnpm test           # suite complète
pnpm build          # compile dist/ (prepublishOnly le rejouera de toute façon)
```

## 3. Brancher, PR, merger

Jamais de commit direct sur `main`.

```bash
git checkout -b chore/bump-<version>
git add package.json src/index.ts
git commit -m "chore: préparer la version <version>"
git push -u origin chore/bump-<version>
gh pr create --base main --title "chore: préparer la version <version>"
```

Attendre que le check `verify` passe, puis merger sur `main`.

## 4. Publier sur npm

Depuis `main` à jour et un arbre de travail **propre** :

```bash
git checkout main && git pull --ff-only
npm whoami          # doit répondre le compte ayant les droits sur l'org @skynode-africa
pnpm publish        # prepublishOnly rebuild dist/ ; publishConfig.access=public est déjà fixé
```

Le compte npm a l'**authentification à deux facteurs** activée : `pnpm publish` demande un
code à usage unique (OTP). Deux cas :

- **terminal interactif** : il affiche une URL / un QR code, ou attend le code — suivre
  l'invite ;
- **terminal non interactif** : passer le code en option, `pnpm publish --otp=XXXXXX` (le
  code expire en ~30 s, donc le générer juste avant).

La sortie se termine par `✅ Published package @skynode-africa/mcp@<version>`.

Seuls `dist/`, `README.md` et `LICENSE` sont publiés (champ `files`).

## 5. Vérifier la publication, puis poser le tag

Vérifier **par effet**, pas seulement par la sortie de la commande. Le document agrégé du
paquet peut rester quelques minutes en cache CDN et montrer encore l'ancienne version comme
`latest` ; l'endpoint de la version précise, lui, est fiable tout de suite :

```bash
npm view @skynode-africa/mcp@<version> version
# ou, en contournant le cache local de npm :
curl -s https://registry.npmjs.org/@skynode-africa%2Fmcp/<version> | grep -o '"version":"[^"]*"'
```

Une fois la version confirmée en ligne, poser un tag annoté sur le commit de merge publié,
et le pousser :

```bash
git tag -a v<version> -m "Version <version> — <résumé>" <sha-du-merge>
git push origin v<version>
```

Convention : `v<version>` (ex. `v0.4.1`), annoté, sur le commit de `main` qui correspond à
ce qui a été publié.

## Rappels

- La CI ne publie pas : pousser sur `main` ne met **rien** en ligne sur npm.
- Node 22 et `pnpm@11.17.0` sont épinglés et se tiennent (`packageManager`, `engines`,
  base des images) : ne pas en bouger un seul isolément.
- Les codes OTP et toute connexion npm restent de la responsabilité d'un humain.
