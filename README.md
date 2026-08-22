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

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `SKYNODE_TOKEN` | **Requis.** Votre jeton personnel, commençant par `sky_` |
| `SKYNODE_API_URL` | Facultatif. Par défaut `https://api.skynode.africa/api/v1` |

Le jeton se déclare **par variable d'environnement, jamais en argument de ligne de
commande** : les arguments d'un processus sont lisibles par tout utilisateur de la
machine.

## Prérequis SSH

`inspect_server` s'appuie sur le client `ssh` du système, pas sur une bibliothèque
embarquée.

- Le client `ssh` du système est requis. **Sous Windows, passez par WSL** — le paquet
  suppose la présence de `ssh` et de `tar`.
- **La clé doit déjà être autorisée sur le serveur.** SkyNode n'en détient aucune et
  n'en installe aucune : c'est le corollaire direct de la promesse « ce que SkyNode ne
  voit pas » ci-dessous.
- `inspect_server` **ne modifie rien** : ni installation, ni écriture, ni
  configuration.
- **Une trace, une seule** : la sonde exécute `sudo -n true` pour savoir si
  l'élévation est possible. Hors `sudoers`, le réglage `mail_no_user` par défaut de
  sudo écrit une ligne dans `auth.log` et envoie un courriel à root. Rien n'est
  modifié — mais si vous retrouvez cette ligne dans vos journaux, c'est bien
  `inspect_server` qui l'a laissée.

## Ce que SkyNode ne voit pas

Ce serveur tourne sur votre machine. SkyNode ne reçoit que les appels d'API classiques
de votre compte — les mêmes que ceux de votre espace client. La session SSH ouverte par
`inspect_server` part elle aussi de votre machine : ni la clé privée, ni la sortie de la
sonde ne transitent par l'infrastructure SkyNode.

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
