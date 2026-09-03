// Banc d'essai du transfert et de la construction : joue les cinq points de l'étape 4 de la
// tâche 6 contre un vrai conteneur portant Docker.
//
// `transferProject` monte lui-même son tuyau `tar | ssh` et compose ses arguments SSH avec
// `buildSshArgs`, qui ne connaît ni port ni clé — le banc écoute sur un port éphémère avec
// une clé jetable. Plutôt que d'élargir `SshTarget` pour les besoins d'un banc, on passe par
// `options.sshBin` : un enrobage qui ajoute les deux drapeaux. Le code de production reste
// intact, et c'est bien la vraie fonction qui est éprouvée.
//
// Usage :
//   scripts/banc.sh up --with-docker
//   pnpm build
//   BANC_CLE="…/id_ed25519" node scripts/banc-construction.mjs
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Chemin déduit du fichier, jamais écrit en dur : ce dépôt est public et un chemin de
// développeur y désignerait une machine réelle.
const RACINE = dirname(dirname(fileURLToPath(import.meta.url)))
const { transferProject } = await import(join(RACINE, "dist", "transfer.js"))
const { recipeFor } = await import(join(RACINE, "dist", "step.js"))

const NOM = "skynode-banc-docker"
const CLE = process.env.BANC_CLE
if (!CLE) {
  throw new Error(
    "BANC_CLE manque : le chemin de la clé jetable, que « scripts/banc.sh up » émet en banc.cle."
  )
}
const PORT = execFileSync("docker", ["port", NOM, "22"], { encoding: "utf8" })
  .split("\n")[0]
  .split(":")
  .pop()
  .trim()

const OPTIONS_SSH = [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR",
  "-o", "IdentitiesOnly=yes",
  "-i", CLE,
  "-p", PORT,
]

// L'enrobage : `ssh` réel, précédé des drapeaux que le banc exige.
const BAC = mkdtempSync(join(tmpdir(), "skynode-banc-pilote-"))
const SSH_ENROBE = join(BAC, "ssh")
writeFileSync(
  SSH_ENROBE,
  `#!/bin/sh\nexec ssh ${OPTIONS_SSH.map((o) => `'${o}'`).join(" ")} "$@"\n`
)
chmodSync(SSH_ENROBE, 0o755)

const CIBLE = { host: "127.0.0.1", user: "root" }

function ssh(script) {
  return new Promise((resolve) => {
    const enfant = spawn("ssh", [...OPTIONS_SSH, "-T", "-l", "root", "127.0.0.1", "/bin/sh", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    enfant.stdout.setEncoding("utf8")
    enfant.stderr.setEncoding("utf8")
    enfant.stdout.on("data", (c) => (stdout += c))
    enfant.stderr.on("data", (c) => (stderr += c))
    enfant.stdin.on("error", () => {})
    enfant.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
    enfant.stdin.write(script)
    enfant.stdin.end()
  })
}

function statut(sortie) {
  const ligne = sortie.split("\n").find((l) => l.startsWith("step.outcome\t"))
  return ligne ? ligne.slice("step.outcome\t".length) : "(aucun)"
}

const WORK = "/opt/skynode/work/boutique"
// Deux arborescences, parce que les deux points ne prouvent pas la même chose. La première
// porte un `.env`, un `node_modules` et un fichier de verrouillage factice : elle éprouve les
// exclusions et la non-fuite. La seconde n'a aucune dépendance et construit vraiment : elle
// éprouve le Dockerfile engendré, sans faire dépendre le banc d'un registre distant.
const PROJET_EXCLUSIONS = join(RACINE, "fixtures", "next-sans-dockerfile")
const PROJET_CONSTRUCTIBLE = join(RACINE, "fixtures", "node-constructible")
const CTX = { application: "boutique", projectRoot: PROJET_CONSTRUCTIBLE, workDir: WORK }
const ETAPE_GEN = {
  type: "build.generate_dockerfile",
  famille: "node",
  version: "22",
  gestionnaire: "pnpm",
  sortie: "server",
  port: 3000,
}
const ETAPE_IMG = { type: "build.image", source: { type: "local", path: PROJET_CONSTRUCTIBLE }, tag: "boutique" }

async function point1() {
  console.error("\n=== 1. transfert ===")
  const r = await transferProject(CIBLE, PROJET_EXCLUSIONS, WORK, null, { sshBin: SSH_ENROBE })
  console.error(`ok=${r.ok} fichiers=${r.fichiers}`)
  console.error(r.detail)
  if (r.diagnostic) console.error(`diagnostic: ${r.diagnostic}`)
  const arbre = await ssh(`find ${WORK} | sort`)
  console.error(arbre.stdout.trim())
  return r
}

async function point2() {
  console.error("\n=== 2. non-fuite (grep des valeurs fictives sur le serveur) ===")
  for (const valeur of ["VALEUR_FICTIVE_A", "VALEUR_FICTIVE_B", "DATABASE_URL", "STRIPE_KEY"]) {
    const r = await ssh(`grep -rl '${valeur}' ${WORK} 2>/dev/null | wc -l`)
    console.error(`${valeur}\t${r.stdout.trim()}`)
  }
  const env = await ssh(`find ${WORK} -name '.env*' | wc -l ; find ${WORK} -name node_modules | wc -l`)
  console.error(`fichiers .env restants / répertoires node_modules : ${env.stdout.trim().split("\n").join(" / ")}`)
}

async function point3() {
  console.error("\n=== 3. génération du Dockerfile puis construction ===")
  const t = await transferProject(CIBLE, PROJET_CONSTRUCTIBLE, WORK, null, { sshBin: SSH_ENROBE })
  console.error(`transfert du projet constructible : ok=${t.ok} fichiers=${t.fichiers}`)
  const fuite = await ssh(`grep -rl 'VALEUR_FICTIVE_C' ${WORK} 2>/dev/null | wc -l`)
  console.error(`VALEUR_FICTIVE_C\t${fuite.stdout.trim()}`)
  const gen = await ssh(recipeFor("build.generate_dockerfile").script(ETAPE_GEN, CTX))
  console.error(`generate_dockerfile → ${statut(gen.stdout)} (code ${gen.code})`)
  if (gen.code !== 0) console.error(gen.stdout + gen.stderr)
  const img = await ssh(recipeFor("build.image").script(ETAPE_IMG, CTX))
  console.error(`build.image → ${statut(img.stdout)} (code ${img.code})`)
  console.error(img.stdout.trim().split("\n").slice(-6).join("\n"))
  if (img.code !== 0) console.error(img.stderr.slice(-2000))
  const images = await ssh("docker images --format '{{.Repository}}:{{.Tag}}' | sort")
  console.error(images.stdout.trim())
  return statut(img.stdout)
}

async function point4() {
  console.error("\n=== 4. rejeu ===")
  const gen = await ssh(recipeFor("build.generate_dockerfile").script(ETAPE_GEN, CTX))
  console.error(`generate_dockerfile → ${statut(gen.stdout)}`)
  const img = await ssh(recipeFor("build.image").script(ETAPE_IMG, CTX))
  console.error(`build.image → ${statut(img.stdout)}`)
  const images = await ssh("docker images --format '{{.Repository}}:{{.Tag}}' | sort")
  console.error(images.stdout.trim())
}

async function point5() {
  console.error("\n=== 5. quatre contenus différents, trois images conservées ===")
  for (const n of [1, 2, 3, 4]) {
    // La variation porte sur un fichier qui entre dans l'image **finale** : un marqueur posé
    // à côté ne changerait que le contexte de construction, et Docker rendrait la même image
    // sous une étiquette de plus — l'élagage n'aurait alors rien à élaguer.
    await ssh(`printf '// passage %s\\n' ${n} >> ${WORK}/src/server.js`)
    const img = await ssh(recipeFor("build.image").script(ETAPE_IMG, CTX))
    const images = await ssh(
      `docker images skynode/boutique --format '{{.Tag}}({{.ID}})' | tr '\\n' ' '`
    )
    const survit = await ssh(
      `docker image inspect skynode/boutique:$(cd ${WORK} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-12) >/dev/null 2>&1 && echo OUI || echo NON`
    )
    console.error(
      `passage ${n} → ${statut(img.stdout)} ; l'image annoncée existe encore : ${survit.stdout.trim()} ; dépôt : ${images.stdout.trim()}`
    )
    if (img.code !== 0) console.error(img.stderr.slice(-1500))
  }
}

const r1 = await point1()
if (!r1.ok) process.exit(1)
await point2()
await point3()
await point4()
await point5()
console.error("\nbanc-construction.end\t1")
