// Appels à l'API Claude : enrichissement de la demande, génération du code
// Blender, vérification visuelle de l'asset.
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const client = config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null;

export function isClaudeConfigured() {
  return Boolean(client);
}

// --- Suivi de la consommation (tokens + coût) ---
// Tarifs API Anthropic en $ par million de tokens (entrée / sortie / lecture cache).
const PRICES_USD_PER_MTOK = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
const DEFAULT_PRICE = { input: 8, output: 40 };

// Le pipeline enregistre un collecteur appelé après chaque requête Claude.
let usageSink = null;
export function trackUsage(sink) {
  usageSink = sink;
}

function reportUsage(model, usage) {
  if (!usageSink || !usage) return;
  const price = PRICES_USD_PER_MTOK[model] || DEFAULT_PRICE;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const tokensIn = (usage.input_tokens || 0) + cacheWrite + cacheRead;
  const tokensOut = usage.output_tokens || 0;
  const cacheReadPrice = price.cacheRead ?? price.input * 0.1;
  const costUsd =
    ((usage.input_tokens || 0) * price.input +
      cacheWrite * price.input * 1.25 +
      cacheRead * cacheReadPrice +
      tokensOut * price.output) / 1e6;
  usageSink({ tokensIn, tokensOut, costUsd });
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// Extraction tolérante : bloc ```json, premier objet { } équilibré,
// et nettoyage des virgules traînantes.
function extractJson(text) {
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);

  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    if (depth > 0) candidates.push(text.slice(start)); // objet jamais refermé (réponse tronquée ?)
  }

  for (const c of candidates) {
    const direct = tryParse(c);
    if (direct !== undefined) return direct;
    const cleaned = tryParse(c.replace(/,\s*([}\]])/g, '$1'));
    if (cleaned !== undefined) return cleaned;
  }
  throw new Error('Réponse Claude sans JSON exploitable');
}

function extractPython(text) {
  const fence = text.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

// Erreur réseau transitoire ? (coupure TLS en plein stream, reset, 5xx, 429)
// Le SDK retente la connexion initiale mais PAS un stream interrompu : on le
// fait ici, sinon un simple "read ETIMEDOUT" fait échouer tout le job.
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED']);
function isTransient(err) {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (TRANSIENT_CODES.has(err?.cause?.code || err?.code)) return true;
  return err?.status === 429 || err?.status === 529 || (err?.status >= 500 && err?.status < 600);
}

async function ask(system, userContent, model, maxTokens) {
  let lastErr;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt) {
      console.warn(`[claude] erreur réseau « ${lastErr.message} » — nouvelle tentative ${attempt}/2 dans ${5 * attempt} s…`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
    try {
      return await askOnce(system, userContent, model, maxTokens);
    } catch (err) {
      if (!isTransient(err)) throw err;
      lastErr = err;
    }
  }
  throw new Error(`API Claude injoignable après 3 tentatives : ${lastErr.message}`);
}

async function askOnce(system, userContent, model = config.claudeModels.code, maxTokens = config.claudeMaxTokens) {
  // Streaming : indispensable pour les longues réponses (scripts Blender)
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  const response = await stream.finalMessage();
  reportUsage(model, response.usage);
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Réponse Claude tronquée (limite de ${maxTokens} tokens atteinte)`);
  }
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation || response.stop_details?.category || 'raison inconnue';
    throw new Error(`Requête refusée par les garde-fous du modèle ${model} : ${why}`);
  }
  return text;
}

// Appel dont on attend du JSON : en cas de réponse invalide, une seconde
// tentative est faite avec une consigne de strict respect du format.
async function askJson(system, userContent, model) {
  try {
    return extractJson(await ask(system, userContent, model));
  } catch (err) {
    console.warn('[claude] JSON invalide, nouvelle tentative :', err.message);
    const retry = await ask(
      system +
        '\n\nIMPORTANT : ta réponse précédente était invalide. Réponds avec un unique objet JSON ' +
        'STRICTEMENT valide (RFC 8259) : guillemets doubles, pas de virgule traînante, ' +
        'pas de commentaire, aucun texte avant ou après.',
      userContent,
      model
    );
    return extractJson(retry);
  }
}

// --- 1. Enrichissement de la demande utilisateur en spécification détaillée ---
export async function enrichSpec(userPrompt) {
  const system = `Tu es un directeur artistique 3D pour un studio de jeux vidéo/VR.
On te donne une demande d'asset 3D en langage naturel. Tu la transformes en
spécification précise et réaliste pour un modeleur. Tu réponds UNIQUEMENT avec
un objet JSON de cette forme :
{
  "name": "nom court de l'asset (slug, minuscules, tirets)",
  "description": "description détaillée de l'objet",
  "dimensions_m": {"x": largeur, "y": profondeur, "z": hauteur},
  "style": "low-poly | stylisé | réaliste",
  "realism_notes": "notes sur le réalisme, proportions, échelle humaine",
  "parts": ["liste des sous-parties de l'objet"],
  "materials": [{"part": "...", "color_hex": "#RRGGBB", "metallic": 0-1, "roughness": 0-1}],
  "polycount_target": nombre_de_polygones_max,
  "placement": "sol" | "mur"
}
"placement" : "mur" si l'objet s'accroche à un mur (tableau, applique, étagère
murale, panneau, miroir, horloge...), "sol" pour tout ce qui se pose au sol.
Règles : dimensions RÉALISTES en mètres (échelle humaine, l'asset sera posé dans
une scène de jeu à l'échelle 1m = 1 unité). Si la demande ne précise pas le style,
choisis "low-poly" propre et lisible. polycount_target < 20000.`;
  return askJson(system, userPrompt, config.claudeModels.spec);
}

// --- 2. Génération du script Blender (bpy) ---
const BPY_RULES = `Règles STRICTES pour le script :
- Python pur pour Blender 4.x (API bpy), AUCUN import autre que bpy, math, random, bmesh, mathutils.
- Ne JAMAIS toucher au réseau, aux fichiers, à os/sys/subprocess.
- La scène est DÉJÀ vide, ne pas la vider à nouveau.
- Unités : mètres. L'objet doit respecter les dimensions de la spécification
  (une marge de ±10 % est tolérée tant que l'objet reste réaliste à échelle humaine).
- Objet au SOL (placement "sol") : il repose sur le sol, base à Z=0, centré en X=0, Y=0.
- Objet MURAL (placement "mur") : il se plaque contre un mur. Son dos est dans
  le plan XZ à Y=0, son épaisseur s'étend vers -Y (face visible orientée -Y),
  centré en X=0 et en Z=0 (PAS posé au sol).
- Crée des matériaux (Principled BSDF) avec use_nodes=True et les couleurs du spec
  (base color, metallic, roughness). Assigne chaque matériau aux bonnes faces/objets.
- Nomme les objets d'après les parties du spec.
- Reste sous le polycount cible. Modélisation propre : pas de faces internes inutiles.
- À la fin, joins les objets en un seul objet nommé d'après le spec si pertinent
  (sinon garde une hiérarchie propre), et applique les transformations
  (bpy.ops.object.transform_apply).
- Termine par print("DONE") pour confirmer l'exécution.
- Sois efficace : pas de commentaires superflus, utilise des fonctions et des
  boucles pour les éléments répétés (rayons de roue, lattes...). Vise moins de
  300 lignes.
Réponds UNIQUEMENT avec le code Python dans un bloc \`\`\`python.`;

// gen (optionnel) : { id, maxTokens } — modèle choisi par l'utilisateur pour
// la modélisation ; à défaut, le modèle et le plafond configurés dans .env.
export async function generateScript(spec, userPrompt, gen = {}) {
  const system = `Tu es un expert en modélisation 3D procédurale avec l'API Python de Blender.
Tu écris un script bpy complet qui modélise l'asset décrit. ${BPY_RULES}`;
  const text = await ask(
    system,
    `Demande initiale de l'utilisateur :\n${userPrompt}\n\nSpécification :\n${JSON.stringify(spec, null, 2)}`,
    gen.id,
    gen.maxTokens
  );
  return extractPython(text);
}

// --- 3. Correction du script d'après les problèmes détectés ---
export async function fixScript(spec, userPrompt, previousScript, problems, execError, gen = {}) {
  const system = `Tu es un expert en modélisation 3D procédurale avec l'API Python de Blender.
On te donne un script bpy, et la liste des problèmes constatés sur le résultat
(ou l'erreur d'exécution). Tu réécris le script EN ENTIER, corrigé. ${BPY_RULES}`;
  const text = await ask(
    system,
    `Demande initiale :\n${userPrompt}\n\nSpécification :\n${JSON.stringify(spec, null, 2)}\n\n` +
      `Script précédent :\n\`\`\`python\n${previousScript}\n\`\`\`\n\n` +
      (execError
        ? `Le script a PLANTÉ avec cette erreur :\n${execError}\n`
        : `Problèmes constatés sur les rendus du modèle :\n- ${problems.join('\n- ')}\n`),
    gen.id,
    gen.maxTokens
  );
  return extractPython(text);
}

// --- 4. Vérification visuelle : l'asset correspond-il à la demande ? ---
export async function verifyAsset(userPrompt, spec, imagePaths, sceneSummary) {
  const system = `Tu es contrôleur qualité 3D. On te montre des rendus d'un asset 3D
généré automatiquement, la demande initiale et la spécification. Tu vérifies que
l'objet correspond à la demande : forme reconnaissable, proportions, échelle,
couleurs/matériaux, pas de géométrie aberrante (objet vide, explosé, plat...).
Réponds UNIQUEMENT avec un JSON :
{"valid": true|false, "score": 0-10, "problems": ["problème concret 1", ...], "placement": "sol"|"mur"}
"placement" : décide si cet objet se place au SOL ("sol") ou s'accroche à un
MUR ("mur" : tableau, applique, étagère murale, panneau, miroir, horloge...).
"problems" est vide si valid=true. Sois exigeant mais raisonnable : un style
low-poly assumé n'est pas un défaut.
ÉCHELLE : une petite différence de dimensions avec la spécification (jusqu'à
environ ±10 %) est ACCEPTABLE et ne doit PAS être signalée comme problème.
Ne signale l'échelle que si l'écart est nettement plus grand, si les
proportions internes sont fausses, ou si l'objet n'est plus réaliste par
rapport à une échelle humaine (1 unité = 1 mètre).`;

  const content = [
    {
      type: 'text',
      text:
        `Demande initiale :\n${userPrompt}\n\nSpécification :\n${JSON.stringify(spec, null, 2)}\n\n` +
        `Données de la scène Blender :\n${JSON.stringify(sceneSummary, null, 2)}\n\n` +
        `Voici les rendus (face, trois-quarts, arrière, dessus) :`,
    },
  ];
  for (const p of imagePaths) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: fs.readFileSync(p).toString('base64'),
      },
    });
  }
  const result = await askJson(system, content, config.claudeModels.verify);
  return {
    valid: Boolean(result.valid),
    score: Number(result.score) || 0,
    problems: Array.isArray(result.problems) ? result.problems.map(String) : [],
    placement: result.placement === 'mur' ? 'mur' : 'sol',
  };
}
