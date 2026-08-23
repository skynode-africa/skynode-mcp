# @skynode/mcp

Serveur MCP qui donne à votre agent de code — Claude Code, Cursor, Codex — la visibilité
sur vos serveurs [SkyNode](https://skynode.africa).

Ce paquet est en **lecture seule** : il ne modifie rien, ne peut ni commander ni payer.
La session SSH qu'il ouvre pour constater un serveur l'est tout autant.

## Installation

Créez d'abord un jeton d'accès personnel dans votre espace client, sur
**/compte/securite**, en cochant la portée **« Lire mes serveurs et leur état »**. La
valeur n'est affichée qu'une seule fois.

### Claude Code

```bash
claude mcp add skynode --env SKYNODE_TOKEN=sky_votre_jeton -- npx -y @skynode/mcp
```

### Cursor, Windsurf, Codex

Dans la configuration MCP de votre client :

```json
{
  "mcpServers": {
    "skynode": {
      "command": "npx",
      "args": ["-y", "@skynode/mcp"],
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

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `SKYNODE_TOKEN` | **Requis.** Votre jeton personnel, commençant par `sky_` |
| `SKYNODE_API_URL` | Facultatif. Par défaut `https://api.skynode.africa/api/v1` |

Le jeton se déclare **par variable d'environnement, jamais en argument de ligne de
commande** : les arguments d'un processus sont lisibles par tout utilisateur de la
machine.

## Ce que le plan n'est pas

`plan_deployment` constate votre projet et votre serveur, puis **propose** — il n'applique
rien.

- **Un plan n'exécute rien.** Cette version du paquet sait constater et proposer ;
  l'exécution arrive au jalon suivant. Rien de ce que rend `plan_deployment` ne touche à
  votre serveur.
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
  déchiffrer. C'est ce texte-là que vous approuverez.

## Prérequis SSH

`inspect_server` s'appuie sur le client `ssh` du système, pas sur une bibliothèque
embarquée. **`plan_deployment` ouvre la même session** : il rejoue exactement la même
sonde que `inspect_server` avant de composer un plan — les prérequis ci-dessous
s'appliquent aux deux.

- Le client `ssh` du système est requis. **Sous Windows, passez par WSL** — le paquet
  suppose la présence de `ssh` et de `tar`.
- **La clé doit déjà être autorisée sur le serveur.** SkyNode n'en détient aucune et
  n'en installe aucune : c'est le corollaire direct de la promesse « ce que SkyNode ne
  voit pas » ci-dessous.
- `inspect_server` et `plan_deployment` **ne modifient rien** : ni installation, ni
  écriture, ni configuration.
- **Une trace, une seule** : la sonde exécute `sudo -n true` pour savoir si
  l'élévation est possible. Hors `sudoers`, le réglage `mail_no_user` par défaut de
  sudo écrit une ligne dans `auth.log` et envoie un courriel à root. Rien n'est
  modifié — mais si vous retrouvez cette ligne dans vos journaux, c'est bien
  `inspect_server` ou `plan_deployment` qui l'a laissée.

## Ce que SkyNode ne voit pas

Ce serveur tourne sur votre machine. SkyNode ne reçoit que les appels d'API classiques
de votre compte — les mêmes que ceux de votre espace client. La session SSH ouverte par
`inspect_server`, ou par `plan_deployment` lorsqu'il constate le serveur avant de
composer un plan, part elle aussi de votre machine : ni la clé privée, ni la sortie de
la sonde ne transitent par l'infrastructure SkyNode.

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
