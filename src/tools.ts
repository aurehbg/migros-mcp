import {
  searchProducts as apiSearchProducts,
  getProductDetails as apiGetProductDetails,
  getStock as apiGetStock,
  getCategories as apiGetCategories,
  searchStores as apiSearchStores,
  getPromotions as apiGetPromotions,
  getRecipeDetails as apiGetRecipeDetails,
} from "./migros.js";
import {
  getRecipeProductIds,
  migustoLang,
  recipeUrl,
  searchRecipes as migustoSearchRecipes,
} from "./migusto.js";

const SEARCH_LANGUAGES = ["de", "en", "fr", "it"];
const THIN_RESULT_COUNT = 5;

/**
 * Migros search only matches a query in the language passed alongside it, and
 * multi-word queries with adjectives ("fresh tomatoes") return nothing. When
 * the query as given finds nothing, retry it in the other languages, then
 * retry with only its last word (usually the noun).
 */
function searchAttempts(query: string, language: string): Array<{ query: string; language: string }> {
  const langs = [language, ...SEARCH_LANGUAGES.filter((l) => l !== language)];
  const attempts = langs.map((l) => ({ query, language: l }));
  const words = query.trim().split(/\s+/);
  if (words.length > 1) {
    const lastWord = words[words.length - 1];
    attempts.push(...langs.map((l) => ({ query: lastWord, language: l })));
  }
  return attempts;
}

export async function searchProducts(
  query: string,
  language: string
): Promise<string> {
  for (const attempt of searchAttempts(query, language)) {
    const result = await apiSearchProducts(attempt.query, attempt.language);
    if (result.productIds.length === 0) continue;

    const isFallback = attempt.query !== query || attempt.language !== language;

    // A handful of hits often means the query language doesn't match
    // ("tomatoes" under de → 1 result, under en → 182). Don't guess (the
    // largest count is often noise), just report what the others return.
    let otherLanguages: Record<string, number> | undefined;
    if (!isFallback && result.numberOfProducts < THIN_RESULT_COUNT) {
      otherLanguages = {};
      for (const l of SEARCH_LANGUAGES.filter((l) => l !== language)) {
        otherLanguages[l] = (await apiSearchProducts(query, l)).numberOfProducts;
      }
    }

    return JSON.stringify(
      {
        numberOfProducts: result.numberOfProducts,
        productIds: result.productIds,
        ...(isFallback && {
          matchedWith: attempt,
          note: `No results for "${query}" (${language}); showing results for "${attempt.query}" (${attempt.language}). Check product names are what you wanted.`,
        }),
        ...(otherLanguages && {
          otherLanguages,
          note: `Few results. If "${query}" is not ${language}, search again with the matching language; counts for the other languages are in otherLanguages.`,
        }),
        hint: "Use get_product_details with these product IDs to get full product info including nutrition, price, and ingredients.",
      },
      null,
      2
    );
  }

  return JSON.stringify({
    message: `No products found for "${query}" in any language, including retries with only the last word. Try a single noun or the German term.`,
    numberOfProducts: 0,
    productIds: [],
  });
}

function formatNutrition(product: Record<string, unknown>): string | null {
  const productInfo = product.productInformation as Record<string, unknown> | undefined;
  const nutrients = (productInfo?.nutrientsInformation ?? product.nutrientsInformation) as
    | { nutrientsTable?: { headers?: unknown[]; rows?: unknown[] } }
    | undefined;

  if (!nutrients?.nutrientsTable?.rows) return null;

  const table = nutrients.nutrientsTable;
  const headers = (table.headers as Array<{ label?: string; unit?: string }>) ?? [];
  const rows = (table.rows as Array<{ label?: string; values?: string[] }>) ?? [];

  if (rows.length === 0) return null;

  // Headers can be strings or objects with label/unit
  const headerLabels = headers.map((h) => {
    if (typeof h === "string") return h;
    return `${h.label ?? ""}${h.unit ? ` (${h.unit})` : ""}`;
  });

  const lines: string[] = [];
  lines.push(`| Nutrient | ${headerLabels.join(" | ")} |`);
  lines.push(`| --- | ${headerLabels.map(() => "---").join(" | ")} |`);

  for (const row of rows) {
    const values = (row.values ?? []).join(" | ");
    lines.push(`| ${row.label ?? ""} | ${values} |`);
  }

  return lines.join("\n");
}

function formatProduct(product: Record<string, unknown>): Record<string, unknown> {
  const p = product as Record<string, unknown>;
  const productInfo = p.productInformation as Record<string, unknown> | undefined;
  const mainInfo = productInfo?.mainInformation as Record<string, unknown> | undefined;

  // Brand can be top-level or nested in mainInformation
  const brandInfo = mainInfo?.brand as Record<string, unknown> | undefined;
  const brand = p.brand ?? brandInfo?.name;

  const formatted: Record<string, unknown> = {
    uid: p.uid,
    migrosId: p.migrosId,
    name: p.name ?? p.title,
    brand: brand,
    versioning: p.versioning,
    description: p.description,
  };

  // Price info (under offer.price)
  const offer = p.offer as Record<string, unknown> | undefined;
  const offerPrice = offer?.price as Record<string, unknown> | undefined;
  if (offerPrice) {
    formatted.price = `CHF ${offerPrice.advertisedDisplayValue}`;
    const unitPrice = offerPrice.unitPrice as Record<string, unknown> | undefined;
    if (unitPrice) {
      formatted.unitPrice = `CHF ${unitPrice.value}/${unitPrice.unit}`;
    }
  }
  // Promotional price
  const promoPrice = offer?.promotionPrice as Record<string, unknown> | undefined;
  if (promoPrice?.advertisedDisplayValue) {
    formatted.promoPrice = `CHF ${promoPrice.advertisedDisplayValue}`;
  }
  if (offer?.quantity) {
    formatted.quantity = offer.quantity;
  }

  // Ratings
  const rating = mainInfo?.rating as Record<string, unknown> | undefined;
  const ratings = (rating ?? p.ratings) as Record<string, unknown> | undefined;
  if (ratings) {
    formatted.ratings = {
      average: ratings.nbStars ?? ratings.average,
      count: ratings.nbReviews ?? ratings.count,
    };
  }

  // Ingredients
  const ingredients = mainInfo?.ingredients ?? p.ingredients;
  if (ingredients) {
    // Strip HTML tags
    formatted.ingredients = (ingredients as string).replace(/<[^>]*>/g, "");
  }

  // Allergens
  const allergens = mainInfo?.allergens ?? mainInfo?.allergenIndication ?? p.allergenText;
  if (allergens) {
    formatted.allergens = allergens;
  }

  // Nutrition table (formatted as markdown)
  const nutritionTable = formatNutrition(product);
  if (nutritionTable) {
    formatted.nutrition = nutritionTable;
  }

  // Categories
  const categories = p.categories as Array<Record<string, unknown>> | undefined;
  if (categories && categories.length > 0) {
    formatted.categories = categories.map((c) => c.name ?? c.code).filter(Boolean);
  }

  // GTINs
  if (p.gtins) {
    formatted.gtins = p.gtins;
  }

  // Availability
  const availability = p.productAvailability as Record<string, unknown> | undefined;
  if (availability) {
    formatted.isAvailable = availability.isAvailable;
  }

  return formatted;
}

export async function getProductDetails(
  productIds: string[]
): Promise<string> {
  const products = await apiGetProductDetails(productIds);

  if (!products || (products as unknown[]).length === 0) {
    return JSON.stringify({
      message: "No product details found for the given IDs",
      productIds,
    });
  }

  const formatted = (products as Record<string, unknown>[]).map(formatProduct);

  return JSON.stringify(formatted, null, 2);
}

export async function getStock(
  productId: string,
  storeId: string
): Promise<string> {
  const result = await apiGetStock(productId, storeId);

  if (result.stock === null) {
    return JSON.stringify({
      productId,
      storeId,
      inStock: false,
      message: "Product not available at this store or stock data unavailable.",
    });
  }

  return JSON.stringify({
    productId,
    storeId,
    inStock: result.stock > 0,
    stock: result.stock,
    note: "Stock is updated once a day and is approximate.",
  });
}

export async function getCategories(): Promise<string> {
  const categories = await apiGetCategories();
  return JSON.stringify(categories, null, 2);
}

export async function searchStores(query: string): Promise<string> {
  const stores = await apiSearchStores(query);

  if (!stores || stores.length === 0) {
    return JSON.stringify({
      message: `No stores found for "${query}"`,
    });
  }

  return JSON.stringify(stores, null, 2);
}

export async function getPromotions(query: string): Promise<string> {
  const items = await apiGetPromotions(query);
  return JSON.stringify(items, null, 2);
}

// ---------------------------------------------------------------------------
// Recipes (Migusto)
// ---------------------------------------------------------------------------

/** ISO 8601 duration ("PT1H20M") -> minutes. */
function isoMinutes(d?: string): number | undefined {
  const m = d ? /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d) : null;
  return m && (m[1] || m[2]) ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : undefined;
}

export async function searchRecipes(args: {
  query?: string;
  ingredients?: string[];
  language?: string;
  limit?: number;
  offset?: number;
}): Promise<string> {
  // Migusto only serves German, French, and Italian — no English content.
  const lang = migustoLang(args.language);
  const result = await migustoSearchRecipes({ ...args, language: lang });
  const list = result.recipes;
  const unmatched = result.ingredients.filter((i) => !i.matched).map((i) => i.input);

  return JSON.stringify(
    {
      count: list.length,
      total: result.total,
      language: lang,
      ...(result.ingredients.length ? { ingredients: result.ingredients } : {}),
      recipes: list.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        durationMinutes: isoMinutes(r.duration),
        rating: r.rating,
        teaser: r.description,
        hasDiscount: r.hasDiscount,
        image: r.image,
        url: r.slug ? recipeUrl(lang, r.slug, r.id) : undefined,
      })),
      hint:
        list.length > 0
          ? "Use get_recipe_details with a slug for ingredients + instructions. Use get_recipe_products with the slug to get Migros products you can add to the basket."
          : unmatched.length
            ? `No recipes matched. Unknown ingredient(s): ${unmatched.join(", ")} — use the ${lang} name.`
            : "No recipes matched. Try different search terms. Note: Migusto only serves de/fr/it content.",
    },
    null,
    2
  );
}

export async function getRecipeDetails(args: { slug: string; language?: string }): Promise<string> {
  const result = await apiGetRecipeDetails({ slug: args.slug, language: args.language ?? "de" });
  return JSON.stringify(result, null, 2);
}

export async function getRecipeProducts(args: {
  slug?: string;
  recipeId?: string;
  language?: string;
  limit?: number;
  offset?: number;
}): Promise<string> {
  if (!args.slug) {
    throw new Error(
      "get_recipe_products needs the recipe slug (Migusto no longer resolves bare recipe ids). " +
        "Get it from search_recipes, get_favorite_recipes or get_cookbooks."
    );
  }
  const lang = migustoLang(args.language);
  const recipe = await getRecipeProductIds({ slug: args.slug, recipeId: args.recipeId, language: lang });
  const offset = args.offset ?? 0;
  const ids = recipe.productIds.slice(offset, offset + (args.limit ?? 50));

  // Recipe pages list 12-digit migrosIds; add_to_basket wants the product uid.
  const details = ids.length ? ((await apiGetProductDetails(ids)) as Record<string, unknown>[]) : [];
  const byMigrosId = new Map(details.map((p) => [String(p.migrosId), formatProduct(p)]));
  const products = ids.map((migrosId) => {
    const p = byMigrosId.get(migrosId);
    return p
      ? { uid: p.uid == null ? null : String(p.uid), migrosId, name: p.name, brand: p.brand, price: p.price, unitPrice: p.unitPrice }
      : { uid: null, migrosId, name: null };
  });

  return JSON.stringify(
    {
      recipe: { id: recipe.id, slug: recipe.slug, title: recipe.title },
      count: products.length,
      total: recipe.productIds.length,
      products,
      hint:
        products.length > 0
          ? "Pass a product's uid to add_to_basket."
          : "Migusto lists no Migros products for this recipe.",
    },
    null,
    2
  );
}
