import { MIGUSTO, migustoApi, resolveRecipeSlug } from "../auth/migusto.js";
import { credsFromEnv } from "./_shared.js";

interface CookbookResponse<T> {
  status: number;
  data: T;
}

interface Cookbook {
  id: string;
  title: string;
  recipeCount?: number;
  imageUrl?: string;
  recipes?: { recipeId: string }[];
}

function migustoLang(language?: string): string {
  return language && ["de", "fr", "it"].includes(language) ? language : "de";
}

/**
 * Resolve ids to { id, slug, url } with bounded concurrency so a long
 * favorites list doesn't fire dozens of requests at once.
 */
async function resolveRecipes(ids: string[], lang: string) {
  const out: { id: string; slug: string | null; url: string | null }[] = new Array(ids.length);
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++;
      const slug = await resolveRecipeSlug(ids[i], lang).catch(() => null);
      out[i] = { id: ids[i], slug, url: slug ? `${MIGUSTO}/${lang}/r/${ids[i]}` : null };
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
  return out;
}

/**
 * List the user's favorite (bookmarked) Migusto recipes, with slugs so the
 * caller can feed them straight into get_recipe_details.
 */
export async function getFavoriteRecipes(args: { language?: string }): Promise<string> {
  const lang = migustoLang(args.language);
  const favorites = ((await migustoApi("GET", "/.rest/favorites/v1/recipe", undefined, {
    creds: credsFromEnv(),
  })) ?? {}) as Record<string, string>;
  const ids = Object.keys(favorites);
  const recipes = await resolveRecipes(ids, lang);

  return JSON.stringify(
    {
      count: recipes.length,
      language: lang,
      recipes,
      hint:
        recipes.length > 0
          ? "Use get_recipe_details with a slug for ingredients + instructions, or get_recipe_products with the id."
          : "No favorite recipes saved on Migusto.",
    },
    null,
    2
  );
}

/**
 * List the user's Migusto cookbooks (Kochbücher) and the recipes in each.
 */
export async function getCookbooks(args: { language?: string }): Promise<string> {
  const lang = migustoLang(args.language);
  const res = (await migustoApi("GET", "/.rest/cookbooks/v1/books", undefined, {
    creds: credsFromEnv(),
  })) as CookbookResponse<Cookbook[]>;
  const books = res?.data ?? [];

  const result = [];
  for (const b of books) {
    const ids = (b.recipes ?? []).map((r) => String(r.recipeId));
    result.push({
      id: b.id,
      title: b.title,
      recipeCount: b.recipeCount ?? ids.length,
      recipes: await resolveRecipes(ids, lang),
    });
  }
  return JSON.stringify({ count: result.length, language: lang, cookbooks: result }, null, 2);
}

export async function addFavoriteRecipe(args: { recipeId: string | number }): Promise<string> {
  const id = String(args.recipeId);
  await migustoApi("POST", `/.rest/favorites/v1/recipe/${encodeURIComponent(id)}`, undefined, {
    creds: credsFromEnv(),
  });
  return JSON.stringify({ ok: true, added: id });
}

export async function removeFavoriteRecipe(args: { recipeId: string | number }): Promise<string> {
  const id = String(args.recipeId);
  await migustoApi("DELETE", `/.rest/favorites/v1/recipe/${encodeURIComponent(id)}`, undefined, {
    creds: credsFromEnv(),
  });
  return JSON.stringify({ ok: true, removed: id });
}
