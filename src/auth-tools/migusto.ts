import {
  bookmarksPath,
  cookbookPath,
  migustoAction,
  migustoPage,
  parseRecipeCards,
  recipeUrl,
  type MigustoLang,
  type RecipeCard,
} from "../auth/migusto.js";
import { credsFromEnv } from "./_shared.js";

interface ActionResult<T> {
  data?: T;
  error?: { status?: number; messageCode?: string; message?: string } | null;
}

interface Cookbook {
  id: string;
  title?: string;
  recipeCount?: number;
  imageUrl?: string;
  recipes?: { recipeId: string | number }[];
  recipeIds?: (string | number)[];
}

function migustoLang(language?: string): MigustoLang {
  return language === "fr" || language === "it" ? language : "de";
}

function describe(ids: string[], cards: Map<string, RecipeCard>, lang: MigustoLang) {
  return ids.map((id) => {
    const c = cards.get(id);
    const slug = c?.slug ?? null;
    return { id, title: c?.title ?? null, slug, url: slug ? recipeUrl(lang, slug, id) : null };
  });
}

function actionError(name: string, e: ActionResult<unknown>["error"]): Error {
  return new Error(`Migusto ${name} failed: ${e?.messageCode ?? e?.message ?? JSON.stringify(e)}`);
}

/**
 * List the user's favorite (bookmarked, "Merkliste") Migusto recipes, with
 * slugs so the caller can feed them straight into get_recipe_details.
 */
export async function getFavoriteRecipes(args: { language?: string }): Promise<string> {
  const lang = migustoLang(args.language);
  const opts = { creds: credsFromEnv() };
  const res = await migustoAction<{ recipeIds?: (string | number)[]; error?: unknown }>(
    "serverActionFetchBookmarks", [], opts
  );
  if (res?.error) throw actionError("fetch bookmarks", res.error as ActionResult<unknown>["error"]);
  const ids = (res?.recipeIds ?? []).map(String);
  const cards = ids.length ? parseRecipeCards(await migustoPage(bookmarksPath(lang), opts)) : new Map();
  const recipes = describe(ids, cards, lang);

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
  const opts = { creds: credsFromEnv() };
  const res = await migustoAction<ActionResult<Cookbook[]>>("severActionFetchCookbooks", [], opts);
  if (res?.error) throw actionError("fetch cookbooks", res.error);
  const books = (res?.data ?? []).filter((b) => b?.id);

  const result = [];
  for (const b of books) {
    const html = await migustoPage(cookbookPath(lang, String(b.id)), opts);
    const cards = parseRecipeCards(html);
    let ids = (b.recipeIds ?? b.recipes?.map((r) => r.recipeId) ?? []).map(String);
    if (ids.length === 0) {
      // The list action may not include members; the cookbook page does.
      const m = /"collectionRecipeIds":(\[[^\]]*\])/.exec(html.replace(/\\"/g, '"'));
      ids = m ? (JSON.parse(m[1]) as string[]).map(String) : [...cards.keys()];
    }
    result.push({
      id: String(b.id),
      title: b.title ?? null,
      recipeCount: b.recipeCount ?? ids.length,
      recipes: describe(ids, cards, lang),
    });
  }
  return JSON.stringify({ count: result.length, language: lang, cookbooks: result }, null, 2);
}

export async function addFavoriteRecipe(args: { recipeId: string | number }): Promise<string> {
  const id = String(args.recipeId);
  const res = await migustoAction<{ success?: boolean; error?: ActionResult<unknown>["error"] }>(
    "serverActionAddBookmark", [id], { creds: credsFromEnv() }
  );
  if (!res?.success) throw actionError("add bookmark", res?.error);
  return JSON.stringify({ ok: true, added: id });
}

export async function removeFavoriteRecipe(args: { recipeId: string | number }): Promise<string> {
  const id = String(args.recipeId);
  const res = await migustoAction<{ success?: boolean; error?: ActionResult<unknown>["error"] }>(
    "serverActionRemoveBookmark", [id], { creds: credsFromEnv() }
  );
  if (!res?.success) throw actionError("remove bookmark", res?.error);
  return JSON.stringify({ ok: true, removed: id });
}
