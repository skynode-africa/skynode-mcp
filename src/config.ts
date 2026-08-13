/**
 * Configuration du serveur MCP.
 *
 * Le jeton vient **de l'environnement, jamais d'un argument de ligne de commande** :
 * `ps` expose les arguments de tout processus à tout utilisateur de la machine, et un
 * jeton personnel y resterait visible pendant toute la session de l'agent.
 */

/** Production. Surchargeable par `SKYNODE_API_URL` pour un développement local. */
const DEFAULT_BASE_URL = "https://api.skynode.africa/api/v1"

/** Les jetons personnels portent ce préfixe ; les JWT de session, non. */
const TOKEN_PREFIX = "sky_"

export interface Config {
  token: string
  baseUrl: string
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.SKYNODE_TOKEN?.trim()

  if (!token) {
    throw new Error(
      "SKYNODE_TOKEN est absent. Créez un jeton d'accès personnel dans votre espace " +
        "client, sur /compte/securite, puis déclarez-le dans la configuration de votre " +
        "client MCP."
    )
  }

  /*
    Presque toujours un JWT de session relevé dans les outils de développement du
    navigateur. Sans ce contrôle, l'API répondrait 401 sur chaque appel sans que rien
    n'indique que la valeur elle-même est du mauvais type.
  */
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error(
      `SKYNODE_TOKEN ne ressemble pas à un jeton d'accès personnel : ceux-ci commencent ` +
        `par « ${TOKEN_PREFIX} ». Un jeton de session de navigateur ne convient pas.`
    )
  }

  // Une barre oblique finale doublerait le séparateur et produirait des 404.
  const baseUrl = (env.SKYNODE_API_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "")

  return { token, baseUrl }
}
