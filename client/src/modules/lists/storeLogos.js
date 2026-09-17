// Map store/market names to a look-up domain so the list header can show a
// recognizable logo alongside the list name (shopping lists are usually named
// after the store). The logo is fetched from Google's favicon service, which
// returns the brand's real 96px icon for known domains, a 404 for unknown
// ones, and is free with no API key.

const STORE_DOMAINS = {
  // The user's go-to stores
  "target": "target.com",
  "aldi": "aldi.us",
  "menards": "menards.com",
  "home depot": "homedepot.com",
  "the home depot": "homedepot.com",
  // Groceries
  "walmart": "walmart.com",
  "costco": "costco.com",
  "kroger": "kroger.com",
  "safeway": "safeway.com",
  "meijer": "meijer.com",
  "jewel": "jewelosco.com",
  "jewel-osco": "jewelosco.com",
  "whole foods": "wholefoodsmarket.com",
  "trader joe's": "traderjoes.com",
  "trader joes": "traderjoes.com",
  "sam's club": "samsclub.com",
  "sams club": "samsclub.com",
  "lowes": "lowes.com",
  "lowe's": "lowes.com",
  "publix": "publix.com",
  "sprouts": "sprouts.com",
  "sprouts farmers market": "sprouts.com",
  "wegmans": "wegmans.com",
  "h-e-b": "hebgrocery.com",
  "he-b": "hebgrocery.com",
  "albertsons": "albertsons.com",
  "giant eagle": "gianteagle.com",
  "shoprite": "shoprite.com",
  "hy-vee": "hy-vee.com",
  "hyvee": "hy-vee.com",
  "cub": "cub.com",
  "dollar tree": "dollartree.com",
  "dollar general": "dollargeneral.com",
  // Drug stores
  "cvs": "cvs.com",
  "walgreens": "walgreens.com",
  "rite aid": "riteaid.com",
  // Everything else
  "best buy": "bestbuy.com",
  "amazon": "amazon.com",
  "ace hardware": "acehardware.com",
};

export function storeLogoUrl(name) {
  const key = (name || "").trim().toLowerCase().replace(/\s+/g, " ");
  const domain = STORE_DOMAINS[key];
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=96`;
}