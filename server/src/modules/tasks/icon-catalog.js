// Keyword → Lucide icon name map used to auto-assign a task icon from its name.
// Order matters: earlier entries win. Keywords are matched as substrings of the
// lowercased task name, preferring whole-word matches.

// [regex, iconName] — regex tested against the lowercased name
const RULES = [
  [/\b(trash|rubbish|garbage|recycl|compost|take out)\b/, "trash"],
  [/\b(dish|dishes|dishwasher|laundry|wash|clothes|fold)\b/, "shirt"],
  [/\b(clean|vacuum|sweep|mop|wipe|dust|tidy|organi[sz]e|organi[sz]ation)\b/, "sparkles"],
  [/\b(vacuum)\b/, "vacuum"],
  [/\b(feed|pet|dog|cat|walk the dog|walk dog)\b/, "paw-print"],
  [/\b(breakfast|lunch|dinner|cook|meal|mealplan|snack|bake|groceries|grocery|shopping|shop)\b/, "utensils"],
  [/\b(cook|dinner|lunch|breakfast)\b/, "cooking-pot"],
  [/\b(shopping|grocery|shop|buy|errand|store)\b/, "shopping-cart"],
  [/\b(bath|bathroom|brush|teeth|shower|hair|haircut)\b/, "shower-head"],
  [/\b(school|homework|study|read|book|library|project)\b/, "book-open"],
  [/\b(music|piano|guitar|violin|practice)\b/, "music"],
  [/\b(sport|game|practice|soccer|football|baseball|basketball|hockey|tennis|swim|gym|exercise|run|runny)\b/, "dumbbell"],
  [/\b(play|toy|toys|lego|craft|coloring|color)\b/, "puzzle"],
  [/\b(phone|call|text|message|camera|photo|picture)\b/, "smartphone"],
  [/\b(bed|sleep|nap|wake|make the bed|pyjamas)\b/, "bed"],
  [/\b(garden|yard|mow|lawn|plant|water the plants|weed|rake|leaf)\b/, "shovel"],
  [/\b(fix|repair|build|assemble|tools|screw|nail|maintenance|carpentry)\b/, "wrench"],
  [/\b(paint|paint)\b/, "paintbrush"],
  [/\b(car|garage|drive|park)\b/, "car"],
  [/\b(bike|bicycle)\b/, "bike"],
  [/\b(money|allowance|bank|save|budget)\b/, "wallet"],
  [/\b(medicin|pill|vitamin)\b/, "pill"],
  [/\b(birthday|party|present|gift|celebrat)\b/, "gift"],
  [/\b(homework|school)\b/, "graduation-cap"],
  [/\b(computer|laptop|screen|iphone|tablet)\b/, "laptop"],
  [/\b(help|assist)\b/, "hand-helping"],
  [/\b(walk|outside|play outside|park)\b/, "footprints"],
  [/\b(read|book)\b/, "book"],
  [/\b(mail|letter|package|deliver|parcel)\b/, "package"],
  [/\b(call|phone)\b/, "phone"],
  [/\b(bedroom|room|organi[sz])\b/, "layout-grid"],
];

const PRESET_ICONS = {
  trash: "trash",
  shirt: "shirt",
  sparkles: "sparkles",
  vacuum: "vacuum",
  "paw-print": "paw-print",
  utensils: "utensils",
  "cooking-pot": "cooking-pot",
  "shopping-cart": "shopping-cart",
  "shower-head": "shower-head",
  "book-open": "book-open",
  music: "music",
  dumbbell: "dumbbell",
  puzzle: "puzzle",
  smartphone: "smartphone",
  bed: "bed",
  shovel: "shovel",
  wrench: "wrench",
  paintbrush: "paintbrush",
  car: "car",
  bike: "bike",
  wallet: "wallet",
  pill: "pill",
  gift: "gift",
  "hand-helping": "hand-helping",
  footsteps: "footsteps",
  book: "book",
  package: "package",
  phone: "phone",
  "layout-grid": "layout-grid",
};

// The distinct set of icons available for search, independent of keywords
export const ALL_ICONS = Object.values(PRESET_ICONS).filter(
  (v, i, a) => a.indexOf(v) === i
);

// Matches the lowercased task name against the keyword rules and returns the
// icon name to use, or null when nothing matches.
/** @returns {string | null} */
export function autoAssignIcon(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const [regex, iconName] of RULES) {
    if (regex.test(lower)) return iconName;
  }
  return null;
}

export default {
  autoAssignIcon,
  ALL_ICONS,
};