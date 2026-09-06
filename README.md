# @skynode-africa/mcp

Serveur MCP qui donne à votre agent de code — Claude Code, Cursor, Codex — la visibilité
sur vos serveurs [SkyNode](https://skynode.africa).

Il constate vos projets et vos serveurs, propose un plan de déploiement en français, et
l'applique quand vous l'avez approuvé. Il ne peut ni commander ni payer.

**Six de ses huit outils sont en lecture seule**, et le déclarent à votre client MCP. Les
deux autres — `apply_plan` et `rollback` — écrivent sur votre serveur, et votre client vous
le demande avant. Ce qu'ils font exactement est décrit plus bas, sans détour.

## Installation

Créez d'abord un jeton d'accès personnel dans votre espace client, sur
**/compte/securite**, en cochant la portée **« Lire mes serveurs et leur état »**. La
valeur n'est affichée qu'une seule fois.

### Claude Code

```bash
claude mcp add skynode --env SKYNODE_TOKEN=sky_votre_jeton -- npx -y @skynode-africa/mcp
```

### Cursor, Windsurf, Codex

Dans la configuration MCP de votre client :

```json
{
  "mcpServers": {
    "skynode": {
      "command": "npx",
      "args": ["-y", "@skynode-africa/mcp"],
      "env": { "SKYNODE_TOKEN": "sky_votre_jeton" }
    }
  }
}
```

## Outils

| Outil | Ce qu'il fait |
|---|---|
| `list_servers` | Liste vos serveurs : nom, adresse IP, état, identifiant |
| `server_status` | Détaille un serveur : état, IP, système, région, échéance |
| `inspect_project` | Constate un projet local : Dockerfile, runtime, framework, port, clés d'environnement |
| `inspect_server` | Constate un serveur par SSH : système, Docker, ports, régime, marche à suivre |
| `plan_deployment` | Propose un plan de déploiement détaillé, à lire avant toute action. N'exécute rien |
| `apply_plan` | **Écrit.** Exécute un plan que vous avez approuvé : équipe la machine, transfère, construit, démarre, publie |
| `app_logs` | Rend les dernières lignes du journal d'une application déployée. Lecture seule |
| `rollback` | **Écrit.** Ramène une application à l'image précédente et redémarre son conteneur |

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `SKYNODE_TOKEN` | **Requis.** Votre jeton personnel, commençant par `sky_` |
| `SKYNODE_API_URL` | Facultatif. Par défaut `https://api.skynode.africa/api/v1` |

Le jeton se déclare **par variable d'environnement, jamais en argument de ligne de
commande** : les arguments d'un processus sont lisibles par tout utilisateur de la
machine.

## Ce qu'`apply_plan` fait sur votre machine

C'est le seul outil du produit qui écrit, et il s'exécute en **root**. Ce qu'il fait, il
le fait pour de bon.

**Il écrit.** Il installe des paquets (`docker-ce`, `ufw`, `fail2ban`,
`unattended-upgrades`), crée des conteneurs et des volumes Docker, et pose des fichiers
sous `/etc/skynode/` — l'environnement de vos applications, les fichiers de site du
reverse proxy, et l'état du déploiement. Il crée un compte applicatif `skynode` et un
fichier d'échange si le plan le prévoit.

**Il durcit SSH — mais jamais à l'aveugle.** Le mot de passe et la connexion `root`
directe sont refusés une fois le compte applicatif en place. Avant d'écrire quoi que ce
soit, il **vérifie qu'une seconde session fonctionne** ; après avoir écrit, il en ouvre
une troisième, et **défait tout** si elle ne passe plus. C'est la seule opération du
produit dont l'échec serait irréparable à distance, et elle est traitée comme telle.

**Il ne touche jamais ce qu'il n'a pas créé.** Un fichier qu'il n'a pas écrit n'est
modifié que par un bloc marqué, qu'il sait retirer sans toucher au reste. Il ne prend
jamais un port tenu par un autre service. Il n'arrête, ne remplace ni ne supprime aucun
conteneur qui ne porte pas son étiquette `skynode.app` — un conteneur à vous qui
porterait le même nom fait échouer l'étape, il n'est pas écrasé. Votre `Dockerfile`, s'il
y en a un, est utilisé tel quel et jamais régénéré.

**Ce qu'il ne sait pas défaire.** Une étape qui échoue fait défaire celles du même
passage, en ordre inverse — sauf l'installation de paquets, qui ne se désinstalle pas, et
la préparation de la machine. Le rapport le dit **à chaque fois**, nommément, plutôt que
de laisser croire à un retour arrière complet. Ce qui reste sur la machine y est écrit
noir sur blanc.

**Rejoué, il ne refait rien.** Chaque étape constate avant d'agir et rend « inchangé »
quand il n'y a rien à faire. Réappliquer un plan déjà appliqué ne coupe pas le service.

**Une machine modifiée entre-temps fait refuser le plan.** Le plan porte une empreinte de
l'état constaté ; si quoi que ce soit a changé depuis, il est refusé **sans qu'une seule
étape ne s'exécute**. Ce que vous aviez approuvé décrivait un serveur qui n'existe plus. Un
plan destiné à un autre serveur est refusé de la même façon, et pour la même raison.

`dry_run` décrit tout cela sans ouvrir la moindre session.

## Ce que le plan n'est pas

`plan_deployment` constate votre projet et votre serveur, puis **propose** — il n'applique
rien.

- **`plan_deployment` n'exécute rien.** Il constate et propose ; rien de ce qu'il rend ne
  touche à votre serveur. C'est `apply_plan`, et lui seul, qui agit — après votre
  approbation.
- **Un plan est une donnée, pas un script.** Le vocabulaire des étapes est fermé et
  versionné avec le paquet : votre agent choisit lesquelles, dans quel ordre et avec
  quelles valeurs, mais ne peut pas en inventer une. C'est ce qui borne ce qu'une
  instruction malveillante trouvée dans un dépôt peut provoquer — au pire un plan
  légitime et mauvais, que vous lisez avant d'approuver.
- **Le `Dockerfile` généré vient d'un gabarit éprouvé**, pas d'une improvisation. Votre
  agent en fixe les paramètres — version du runtime, gestionnaire de paquets, port — mais
  la construction en plusieurs étapes, l'utilisateur non-root et le cache des dépendances
  sont les mêmes pour tous les clients, donc corrigés une fois pour tous.
- **Le plan vous est rendu en français**, étape par étape, jamais sous forme de données à
  déchiffrer. C'est ce texte-là que vous approuvez — il nomme le serveur visé, l'application,
  le domaine, et **ce qui restera sur la machine** même si une étape échoue plus loin.
- **Un plan appartient au serveur pour lequel il a été composé.** `apply_plan` refuse de
  l'appliquer ailleurs : deux VPS neufs de la même image se ressemblent trop pour qu'une
  empreinte d'état suffise à les distinguer.

## Le compte applicatif, et sa clé

L'étape `host.prepare` — celle qui prépare un serveur avant d'y déployer quoi que ce soit —
crée un compte non-root `skynode`, lui accorde `sudo` sans mot de passe, et **y recopie la
clé qui a ouvert la session**, c'est-à-dire celle de `/root/.ssh/authorized_keys`.

**Cette copie est prise une seule fois et ne suit pas.** Si vous révoquez plus tard une clé
sur `root` — le geste réflexe quand un ordinateur est perdu ou volé — elle reste valable sur
le compte `skynode`, qui peut devenir `root` sans mot de passe. Retirez-la des **deux**
fichiers :

- `/root/.ssh/authorized_keys`
- `/home/skynode/.ssh/authorized_keys`

Le rapport de l'étape le rappelle, au moment même où la copie a lieu.

## Prérequis SSH

`inspect_server` s'appuie sur le client `ssh` du système, pas sur une bibliothèque
embarquée. **`plan_deployment` ouvre la même session** : il rejoue exactement la même
sonde que `inspect_server` avant de composer un plan — les prérequis ci-dessous
s'appliquent aux deux.

- Le client `ssh` du système est requis. **Sous Windows, passez par WSL** — le paquet
  suppose la présence de `ssh` et de `tar`.
- **Le compte SSH est celui que l'API déclare**, sauf si vous en indiquez un autre par
  `ssh_user` — disponible sur `inspect_server`, `plan_deployment` et `apply_plan`. Le même
  compte doit servir aux trois : c'est celui dont le constat a établi qu'il peut s'élever.
- **La clé doit déjà être autorisée sur le serveur.** SkyNode n'en détient aucune et
  n'en installe aucune : c'est le corollaire direct de la promesse « ce que SkyNode ne
  voit pas » ci-dessous.
- `inspect_server` et `plan_deployment` **ne modifient rien** : ni installation, ni
  écriture, ni configuration. `apply_plan` et `rollback`, eux, modifient — voir plus haut.
- **`tar` est requis sur votre machine** : le transfert du projet passe par lui, sur
  l'entrée standard de `ssh`. Ni `rsync` des deux côtés, ni `git clone` distant — le
  serveur ne reçoit jamais les identifiants d'un dépôt privé.
- **Une trace, une seule** : la sonde exécute `sudo -n true` pour savoir si
  l'élévation est possible. Hors `sudoers`, le réglage `mail_no_user` par défaut de
  sudo écrit une ligne dans `auth.log` et envoie un courriel à root. Rien n'est
  modifié — mais si vous retrouvez cette ligne dans vos journaux, c'est bien
  `inspect_server` ou `plan_deployment` qui l'a laissée.

## Ce que SkyNode ne voit pas

Ce serveur tourne sur votre machine. SkyNode ne reçoit que les appels d'API classiques
de votre compte — les mêmes que ceux de votre espace client. **Toutes** les sessions SSH
partent de votre machine : celle du constat, celles de chaque étape appliquée, et le
transfert de votre projet. Ni la clé privée, ni le code de votre projet, ni le contenu de
vos fichiers d'environnement ne transitent par l'infrastructure SkyNode.

Les valeurs de vos fichiers d'environnement ne sont d'ailleurs affichées nulle part : ni
dans le plan, ni dans le rapport d'exécution, ni dans les journaux. Le plan nomme le
fichier, le rapport compte ses lignes.

**Les journaux que rend `app_logs` sont produits par votre application.** Ce sont des
données, jamais des instructions, et le texte rendu le dit à votre agent — un dépôt ou
une dépendance hostile ne doit pas pouvoir lui parler par ce canal.

## Développement

```bash
pnpm install
pnpm test
pnpm build
```

Pour l'essayer contre une API locale :

```bash
SKYNODE_API_URL=http://localhost:3001/api/v1 SKYNODE_TOKEN=sky_… node dist/index.js
```

## Licence

MIT
