import type { AxiosResponse } from "axios";
import { client, uniformHeaders } from "./auth/oauth.js";

/**
 * Public (anonymous) access to Migusto, Migros' recipe site.
 *
 * migusto.migros.ch is a Next.js app with no public REST API: search results,
 * recipe cards and a recipe's Migros products are read from the React Server
 * Components payload embedded in the server-rendered pages.
 */
export const MIGUSTO = "https://migusto.migros.ch";

export type MigustoLang = "de" | "fr" | "it";

export function migustoLang(language?: string): MigustoLang {
  return language === "fr" || language === "it" ? language : "de";
}

/** Localized route prefixes (from the site's next-intl pathnames table). */
const ROUTES: Record<MigustoLang, { recipe: string; overview: string; bookmarks: string; cookbook: string }> = {
  de: { recipe: "rezepte", overview: "rezept-uebersicht", bookmarks: "sammlung/merkliste", cookbook: "sammlung/kochbuch" },
  fr: { recipe: "recettes", overview: "apercu-des-recettes", bookmarks: "collection/memorise", cookbook: "collection/livre-de-cusine" },
  it: { recipe: "ricette", overview: "panoramica-delle-ricette", bookmarks: "collezione/memorizzate", cookbook: "collezione/ricettario" },
};

export function recipeUrl(lang: MigustoLang, slug: string, id?: string): string {
  return `${MIGUSTO}/${lang}/${ROUTES[lang].recipe}/${slug}${id ? `/${id}` : ""}`;
}
export function bookmarksPath(lang: MigustoLang): string {
  return `/${lang}/${ROUTES[lang].bookmarks}`;
}
export function cookbookPath(lang: MigustoLang, bookId: string): string {
  return `/${lang}/${ROUTES[lang].cookbook}/${encodeURIComponent(bookId)}`;
}

// ---------------------------------------------------------------------------
// Page parsing
// ---------------------------------------------------------------------------

/** Concatenate the RSC flight payload embedded in a Next.js HTML page. */
export function flightData(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      out += JSON.parse(m[1]) as string;
    } catch {
      /* skip malformed chunk */
    }
  }
  return out;
}

/** Return the balanced JSON object/array starting at `start`, or null. */
function balancedJson(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export interface RecipeCard {
  id: string;
  slug: string | null;
  title: string | null;
  description?: string;
  duration?: string;
  rating?: { average?: number; count?: number };
  hasDiscount?: boolean;
  image?: string;
}

interface RawCard {
  id: string;
  title?: string;
  description?: string;
  duration?: string;
  rating?: { average?: number; count?: number };
  hasDiscount?: boolean;
  image?: { sources?: { ratio?: string; url?: string }[] };
  target?: { type?: string; recipe?: { id?: string; slug?: string } };
}

/**
 * Extract recipe cards from a Migusto page, in page order. A card is an
 * object {id, title, ..., target: {type: "RECIPE", recipe: {id, slug}}}.
 */
export function parseRecipeCards(html: string): Map<string, RecipeCard> {
  const data = flightData(html);
  const cards = new Map<string, RecipeCard>();
  for (const m of data.matchAll(/\{"id":"(\d+)","title":"/g)) {
    if (cards.has(m[1])) continue;
    const raw = balancedJson(data, m.index!);
    if (!raw) continue;
    let c: RawCard;
    try {
      c = JSON.parse(raw) as RawCard;
    } catch {
      continue;
    }
    if (c.target?.type !== "RECIPE" || c.target.recipe?.id !== c.id) continue;
    const img = c.image?.sources?.find((x) => x.ratio === "4-3") ?? c.image?.sources?.[0];
    cards.set(c.id, {
      id: c.id,
      slug: c.target.recipe.slug ?? null,
      title: c.title ?? null,
      description: c.description,
      duration: c.duration,
      rating: c.rating,
      hasDiscount: c.hasDiscount,
      image: img?.url?.replace("{stack}", "crop"),
    });
  }
  return cards;
}

/** `"key":[...]` → parsed array (first occurrence), or null. */
export function findJsonArray(data: string, key: string): unknown[] | null {
  const i = data.indexOf(`"${key}":[`);
  if (i < 0) return null;
  const raw = balancedJson(data, i + key.length + 3);
  try {
    return raw ? (JSON.parse(raw) as unknown[]) : null;
  } catch {
    return null;
  }
}

/** `"key":<number>` → number (first occurrence), or null. */
function findNumber(data: string, key: string): number | null {
  const m = new RegExp(`"${key}":(\\d+)`).exec(data);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Anonymous HTTP
// ---------------------------------------------------------------------------

const ANON = { cookies: {}, jwt: null, jwtExp: 0 };

async function anonGet(url: string, accept = "text/html"): Promise<AxiosResponse> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(current).host;
    const r = await client().get(current, {
      headers: uniformHeaders(host, ANON, { Accept: accept }),
      transformResponse: (x) => x,
    });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      current = new URL(r.headers.location, current).toString();
      continue;
    }
    return r;
  }
  throw new Error(`GET ${url}: too many redirects`);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const PAGE_SIZE = 24;

interface TypeaheadIngredient {
  text: string;
  sourceType: string;
  sourceId: string;
}

/** Resolve a free-text ingredient name to Migusto's ingredient facet. */
async function resolveIngredient(name: string, lang: MigustoLang): Promise<TypeaheadIngredient | null> {
  const q = new URLSearchParams({ q: name, locale: `${lang}-CH` });
  const r = await anonGet(`${MIGUSTO}/api/typeahead?${q}`, "application/json");
  if (r.status !== 200) return null;
  const list = ((JSON.parse(String(r.data)) as { ingredients?: TypeaheadIngredient[] }).ingredients ?? []).filter(
    (i) => i.sourceType === "INGREDIENT_FAMILY" || i.sourceType === "INGREDIENT"
  );
  const wanted = name.trim().toLowerCase();
  return (
    list.find((i) => i.text.toLowerCase() === wanted) ??
    list.find((i) => i.sourceType === "INGREDIENT_FAMILY") ??
    list[0] ??
    null
  );
}

/** Same encoding as the site's buildRecipeFilterUrlParts. */
function ingredientFilter(i: TypeaheadIngredient): string {
  const name = i.text.replace(/\s+/g, " ").replace(/[%+/]/g, encodeURIComponent).replace(/_/g, "%5F");
  return i.sourceType === "INGREDIENT_FAMILY" ? `${name}_${i.sourceId}/` : `${name}_/${i.sourceId}`;
}

/**
 * Fetch one 24-card page of the recipe overview. For small page numbers the
 * site renders all pages up to `page` cumulatively; from page 4 on it renders
 * just that page — so keep only the trailing PAGE_SIZE window when needed.
 */
async function overviewPage(lang: MigustoLang, params: URLSearchParams, page: number) {
  const q = new URLSearchParams(params);
  if (page > 1) q.set("page", String(page));
  const r = await anonGet(`${MIGUSTO}/${lang}/${ROUTES[lang].overview}?${q}`);
  // Pages past the last one 404.
  if (r.status === 404 && page > 1) return { cards: [], total: null };
  if (r.status !== 200) throw new Error(`Migusto recipe search -> ${r.status}`);
  const html = String(r.data);
  let cards = [...parseRecipeCards(html).values()];
  if (cards.length > PAGE_SIZE) cards = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return { cards, total: findNumber(flightData(html), "totalRecipes") };
}

export async function searchRecipes(args: {
  query?: string;
  ingredients?: string[];
  language?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number | null; recipes: RecipeCard[]; ingredients: { input: string; matched: string | null }[] }> {
  const lang = migustoLang(args.language);
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;

  const params = new URLSearchParams();
  if (args.query?.trim()) params.set("q", args.query.trim());

  const ingredients: { input: string; matched: string | null }[] = [];
  const filters: string[] = [];
  for (const name of args.ingredients ?? []) {
    const hit = await resolveIngredient(name, lang);
    ingredients.push({ input: name, matched: hit?.text ?? null });
    if (hit) filters.push(ingredientFilter(hit));
  }
  // An unresolved ingredient would silently widen the search; report it instead.
  if (ingredients.some((i) => !i.matched)) return { total: 0, recipes: [], ingredients };
  if (filters.length) params.set("z", filters.join("__"));

  const first = Math.floor(offset / PAGE_SIZE) + 1;
  const last = Math.floor((offset + limit - 1) / PAGE_SIZE) + 1;
  let total: number | null = null;
  const collected: RecipeCard[] = [];
  for (let p = first; p <= last; p++) {
    const page = await overviewPage(lang, params, p);
    total ??= page.total;
    collected.push(...page.cards);
    if (page.cards.length < PAGE_SIZE) break;
  }
  total ??= (await overviewPage(lang, params, 1)).total;
  const start = offset - (first - 1) * PAGE_SIZE;
  let recipes = collected.slice(start, start + limit);
  // Past the end the site falls back to unrelated suggestions; drop them.
  if (total !== null && offset >= total) recipes = [];
  return { total, recipes, ingredients };
}

// ---------------------------------------------------------------------------
// Recipe products
// ---------------------------------------------------------------------------

/**
 * Migros product ids (12-digit migrosIds) listed under "Zutaten in deiner
 * Migros" on a recipe page.
 */
export async function getRecipeProductIds(args: {
  slug: string;
  recipeId?: string;
  language?: string;
}): Promise<{ id: string | null; slug: string; title: string | null; productIds: string[] }> {
  const lang = migustoLang(args.language);
  const r = await anonGet(recipeUrl(lang, encodeURIComponent(args.slug), args.recipeId));
  if (r.status !== 200) throw new Error(`Migusto recipe "${args.slug}" -> ${r.status}`);
  const html = String(r.data);
  const data = flightData(html);
  const productIds = findJsonArray(data, "productIds");
  if (!productIds) {
    if (!/<link rel="canonical"/.test(html)) throw new Error(`Migusto recipe "${args.slug}" not found`);
    return { id: args.recipeId ?? null, slug: args.slug, title: null, productIds: [] };
  }
  const canonical = /<link rel="canonical" href="[^"]*\/([^/"]+)\/(\d+)"/.exec(html);
  const rawTitle = /<title>([^<|]+)/.exec(html)?.[1]?.trim();
  const title = rawTitle
    ? rawTitle
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
    : null;
  return {
    id: canonical?.[2] ?? args.recipeId ?? null,
    slug: canonical?.[1] ?? args.slug,
    title,
    productIds: productIds.map(String),
  };
}
