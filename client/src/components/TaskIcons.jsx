import * as Icons from "lucide-react";

// Lucide has no dedicated lizard icon in the pinned version, so render a
// matching stroke-style one inline (head + body + curling tail).
export function LizardIcon({ size = 24, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M17.6 5.8a2.7 2.7 0 0 1 2.8 2.7c0 .9-.4 1.6-1 2.1l-.8.7c-.5-.5-.8-1.2-.8-2Z" />
      <circle cx="19" cy="7.4" r="0.5" fill="currentColor" stroke="none" />
      <path d="M16.4 9.7c-2.5 1.6-4.9 2.3-7.4 3.4-2 .9-3.6 2.1-4.7 3.8" />
      <path d="M4.3 16.9c-1.4 1.3-2 3-1.4 4.5" />
      <path d="M2.9 21.4c1.3.4 2.2-.1 2.7-.7" />
      <path d="M12.6 11.9 11 10.2" />
      <path d="M9.2 13.4l-2-.9" />
      <path d="M14.8 10.6l1.6-1.2" />
      <path d="M6.6 14.9l-1.9-.2" />
    </svg>
  );
}

// Lucide has no dedicated poop icon in the pinned version, so render a
// matching stroke-style one inline (pile-of-poo: swirl, humps, drippy end).
export function PoopIcon({ size = 24, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 4a2.6 2.6 0 0 1 2.6 2.6c0 1.4-1 2.6-2.4 2.8" />
      <path d="M9.6 9.3c-2.2.7-3.9 2.3-4.6 4.4-.6 1.7.5 3.5 2.2 3.8" />
      <path d="M14.7 9.2c2.3.8 4 2.5 4.5 4.9" />
      <path d="M15 18.4c0 1.5-1.2 2.7-3 2.7s-3-1.2-3-2.7" />
      <path d="M12 21.1c-.2.9-.9 1.5-1.8 1.7" />
    </svg>
  );
}

// Lucide has no dedicated hair-brush icon in the pinned version, so render a
// matching stroke-style one inline (wide bristle pad + handle).
export function HairBrushIcon({ size = 24, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="6" width="13" height="8" rx="1.5" />
      <line x1="5.5" y1="7.5" x2="5.5" y2="12.5" />
      <line x1="8" y1="6.5" x2="8" y2="13.5" />
      <line x1="10.5" y1="6.5" x2="10.5" y2="13.5" />
      <line x1="13" y1="7.5" x2="13" y2="12.5" />
      <path d="M16 8h3.5a2 2 0 0 1 0 4H16Z" />
    </svg>
  );
}

// Lucide has no dedicated toothbrush icon in the pinned version, so render a
// matching stroke-style one inline (bristles + rounded handle).
export function ToothbrushIcon({ size = 24, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="9" width="10.5" height="6" rx="1" />
      <line x1="5" y1="10.5" x2="5" y2="13.5" />
      <line x1="7.5" y1="9.5" x2="7.5" y2="14.5" />
      <line x1="10" y1="10.5" x2="10" y2="13.5" />
      <path d="M13.5 10.5h4a2 2 0 0 1 0 3h-4Z" />
    </svg>
  );
}

// Name → Lucide icon component for task icons.
// Keep in sync with the icon names the server auto-assigns (see
// server/src/modules/tasks/icon-catalog.js). Add icon-name => component here to
// make it available in the picker.
export const iconComponents = {
  trash: Icons.Trash,
  shirt: Icons.Shirt,
  sparkles: Icons.Sparkles,
  vacuum: Icons.RobotVacuum,
  "paw-print": Icons.PawPrint,
  utensils: Icons.Utensils,
  "cooking-pot": Icons.CookingPot,
  "shopping-cart": Icons.ShoppingCart,
  "shower-head": Icons.ShowerHead,
  "book-open": Icons.BookOpen,
  music: Icons.Music,
  dumbbell: Icons.Dumbbell,
  puzzle: Icons.Puzzle,
  smartphone: Icons.Smartphone,
  bed: Icons.Bed,
  shovel: Icons.Shovel,
  wrench: Icons.Wrench,
  paintbrush: Icons.Paintbrush,
  car: Icons.Car,
  bike: Icons.Bike,
  wallet: Icons.Wallet,
  pill: Icons.Pill,
  gift: Icons.Gift,
  "hand-helping": Icons.HandHelping,
  footprints: Icons.Footprints,
  footsteps: Icons.Footprints,
  book: Icons.Book,
  package: Icons.Package,
  phone: Icons.Phone,
  "layout-grid": Icons.LayoutGrid,
  // Additional searchable choices
  star: Icons.Star,
  heart: Icons.Heart,
  leaf: Icons.Leaf,
  sun: Icons.Sun,
  moon: Icons.Moon,
  briefcase: Icons.Briefcase,
  "dollar-sign": Icons.DollarSign,
  clock: Icons.Clock,
  calendar: Icons.Calendar,
  home: Icons.Home,
  user: Icons.User,
  users: Icons.Users,
  key: Icons.Key,
  lock: Icons.Lock,
  "list-checks": Icons.ListChecks,
  // Pet / animal + grooming icons (mirrors icon-catalog.js server rules)
  "toothbrush-sparkles": ToothbrushIcon,
  "hair-brush": HairBrushIcon,
  lizard: LizardIcon,
  poop: PoopIcon,
  rabbit: Icons.Rabbit,
  cat: Icons.Cat,
  turtle: Icons.Turtle,
  bird: Icons.Bird,
  rat: Icons.Rat,
  "mirror-round": Icons.MirrorRound,
};

// Searchable catalog for the picker: label keywords -> icon name
export const iconCatalog = [
  ["trash", "trash, rubbish, garbage, recycle, bin, compost, take out"],
  ["shirt", "laundry, clothes, wash, fold, dishwasher, dishes, iron"],
  ["sparkles", "clean, tidy, organize, dust, sparkle, shine"],
  ["vacuum", "vacuum, hoover, carpet"],
  ["paw-print", "pet, dog, cat, feed, walk dog, animal"],
  ["utensils", "eat, food, meal, meal plan, cooking, dining"],
  ["cooking-pot", "cook, dinner, lunch, breakfast, bake, pot"],
  ["shopping-cart", "shopping, groceries, grocery, buy, store, errand, market"],
  ["shower-head", "shower, bath, bathroom, hygiene, wash, brush teeth"],
  ["book-open", "read, reading, book, homework, study, library"],
  ["music", "music, piano, guitar, practice, instrument, band"],
  ["dumbbell", "sport, exercise, gym, workout, soccer, swim, run, practice"],
  ["puzzle", "play, toy, lego, craft, game, puzzle, fun"],
  ["smartphone", "phone, call, text, message, screen, device"],
  ["bed", "bed, sleep, nap, wake, make bed, pyjamas"],
  ["shovel", "garden, yard, lawn, plant, mow, dig, weed, compost"],
  ["wrench", "fix, repair, build, tools, maintenance, diy, plumbing"],
  ["paintbrush", "paint, art, draw, color, decorating"],
  ["car", "car, vehicle, drive, garage, commute"],
  ["bike", "bike, bicycle, cycle, ride"],
  ["wallet", "money, allowance, budget, bank, save, pay"],
  ["pill", "medicine, pill, vitamin, medication, health"],
  ["gift", "birthday, present, gift, party, celebrate"],
  ["hand-helping", "help, assist, chores, volunteer"],
  ["footprints", "walk, run, outside, exercise"],
  ["book", "book, read, library, study"],
  ["package", "package, parcel, mail, delivery, post"],
  ["phone", "phone, call, contact"],
  ["layout-grid", "organize, room, bedroom, setup, arrange"],
  ["star", "star, favorite, priority, top"],
  ["heart", "heart, love, favorite"],
  ["leaf", "leaf, plants, nature, garden, environment"],
  ["sun", "sun, morning, daylight, outside"],
  ["moon", "moon, night, bedtime"],
  ["briefcase", "work, job, office, business"],
  ["dollar-sign", "money, budget, allowance, finance"],
  ["clock", "time, schedule, reminder, appointment"],
  ["calendar", "calendar, date, event, schedule"],
  ["home", "home, house, chore around the house"],
  ["user", "person, one person, solo"],
  ["users", "people, family, group, everyone"],
  ["key", "key, unlock, security"],
  ["lock", "lock, secure, safety"],
  ["list-checks", "task, checklist, to-do, errand"],
  ["toothbrush-sparkles", "toothbrush, brush teeth, teeth, toothpaste, dental, floss, mouthwash"],
  ["hair-brush", "hair brush, brush hair, comb hair, hair, hairstyle, hairdo, style hair"],
  ["lizard", "lizard, bearded dragon, reptile, gecko, iguana, chameleon, snake, terrarium, pet"],
  ["poop", "poop, dog poop, pick up poop, pooper scooper, dog waste, pet waste, dung, bag it"],
  ["rabbit", "rabbit, bunny, hare"],
  ["cat", "cat, kitten, kitty, pet"],
  ["turtle", "turtle, tortoise"],
  ["bird", "bird, parrot, chicken, pet"],
  ["rat", "rat, mouse, guinea pig, hamster, gerbil, pet"],
  ["mirror-round", "mirror, hand mirror, looking glass, vanity"],
];

export function resolveIcon(name) {
  return iconComponents[name] || Icons.CheckCircle2;
}