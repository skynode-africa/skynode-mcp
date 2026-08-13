# @skynode/mcp

Serveur MCP qui donne à votre agent de code — Claude Code, Cursor, Codex — la visibilité
sur vos serveurs [SkyNode](https://skynode.africa).

Ce paquet est en **lecture seule** : il liste vos serveurs et rend leur état. Il ne
modifie rien, n'ouvre aucune session SSH, et ne peut ni commander ni payer.

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

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `SKYNODE_TOKEN` | **Requis.** Votre jeton personnel, commençant par `sky_` |
| `SKYNODE_API_URL` | Facultatif. Par défaut `https://api.skynode.africa/api/v1` |

Le jeton se déclare **par variable d'environnement, jamais en argument de ligne de
commande** : les arguments d'un processus sont lisibles par tout utilisateur de la
machine.

## Ce que SkyNode ne voit pas

Ce serveur tourne sur votre machine. SkyNode ne reçoit que les appels d'API classiques
de votre compte — les mêmes que ceux de votre espace client.

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
