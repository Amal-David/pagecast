// Generates quirky, memorable, all-words names for published report URLs — e.g.
// "hollow-paperclip", "dreamily-fading-casket", "nostalgic-curie" — in the
// spirit of the random names ngrok / localtunnel / Heroku / Docker assign, but
// with a much larger, multi-theme library and NO trailing random digits.
//
// Zero runtime dependencies on purpose: the root CLI/server forbids npm deps, so
// the word lists are vendored here as plain arrays. They are an ORIGINAL curated
// pack written for Pagecast, spanning existential/mood, whimsical, color,
// texture, size, weather, cosmic, and "famous scientist" themes.
//
// IMPORTANT: these names carry NO entropy tail, so a slug is guessable and is NOT
// an access-control boundary. Uniqueness comes from the large library plus a
// per-publish collision check (see generateUniqueName); secrecy must come from
// password protection, not the URL.
//
// Every emitted name is a valid DNS label — matches
// /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/ and stays well under 63 chars — so it
// can also serve as a clean public slug.

import { randomInt } from "node:crypto";

// Drop anything that is not a clean lowercase word and de-duplicate, so the
// generator is robust even if a list is later edited carelessly.
function clean(words) {
  return [...new Set(words.filter((w) => /^[a-z]{2,20}$/.test(w)))];
}

export const ADVERBS = clean([
  "quietly", "dreamily", "absurdly", "faintly", "eternally", "briskly", "wearily", "gleefully", "softly", "boldly",
  "calmly", "sweetly", "wildly", "gently", "gladly", "grimly", "hastily", "keenly", "lazily", "madly",
  "meekly", "nimbly", "oddly", "primly", "proudly", "rudely", "sadly", "shyly", "slyly", "tartly",
  "vainly", "warmly", "wryly", "aptly", "coyly", "drily", "gaily", "tamely", "duly", "newly",
  "merrily", "cheerily", "drearily", "wistfully", "mournfully", "joyfully", "sleepily", "wakefully", "restlessly", "endlessly",
  "hopelessly", "helplessly", "fearlessly", "carelessly", "recklessly", "ruthlessly", "gracefully", "gratefully", "tactfully", "artfully",
  "blissfully", "wishfully", "mindfully", "gainfully", "painfully", "mercifully", "wonderfully", "faithfully", "skillfully", "willfully",
  "bashfully", "boastfully", "dolefully", "fancifully", "forcefully", "fretfully", "fitfully", "sorrowfully", "tearfully", "thoughtfully",
  "truthfully", "watchfully", "cunningly", "glowingly", "longingly", "lovingly", "mockingly", "soothingly", "sparingly", "strikingly",
  "tellingly", "willingly", "yearningly", "achingly", "amusingly", "charmingly", "daringly", "dashingly", "dazzlingly", "fetchingly",
  "haltingly", "laughingly", "shockingly", "sickeningly", "startlingly", "swimmingly", "teasingly", "weepingly", "wittingly", "beautifully",
  "blindly", "bravely", "briefly", "brightly", "clumsily", "coldly", "crisply", "crookedly", "curiously", "dearly",
  "deeply", "dimly", "drowsily", "eagerly", "earnestly", "easily", "fondly", "frankly", "freely", "frostily",
  "gruffly", "handsomely", "happily", "harshly", "heavily", "hugely", "humbly", "icily", "idly", "jaggedly",
  "jauntily", "jokingly", "jumpily", "kindly", "knowingly", "loudly", "luckily", "mistily", "mutely", "nervously",
  "nicely", "nobly", "numbly", "openly", "palely", "plainly", "quaintly", "queerly", "rapidly", "richly",
  "ripely", "roundly", "rosily", "royally", "rustily", "sagely", "saltily", "scarcely", "secretly", "serenely",
  "sharply", "silently", "simply", "sincerely", "singly", "sleekly", "slowly", "smartly", "smoothly", "snugly",
  "solemnly", "somberly", "sparkly", "speedily", "stiffly", "stoutly", "sternly", "stormily", "strangely", "sturdily",
  "suddenly", "sunnily", "surely", "swiftly", "tenderly", "tersely", "tidily", "tightly", "timidly", "tiredly",
  "tonelessly", "triumphantly", "trustingly", "unevenly", "urgently", "vaguely", "valiantly", "vastly", "vividly", "wanly",
  "wickedly", "wisely", "witlessly", "wobbly", "wondrously", "woozily", "wordlessly", "worriedly", "zanily", "zestfully"
]);

export const ADJECTIVES = clean([
  "hollow", "doomed", "fleeting", "wistful", "vacant", "restless", "weary", "yearning", "forlorn", "somber",
  "wishful", "dreary", "mournful", "ghostly", "faded", "frayed", "wilted", "muted", "numbed", "drowsy",
  "wakeful", "ageless", "timeless", "fated", "brooding", "pensive", "lonesome", "listless", "haunted", "hushed",
  "wandering", "wayward", "aimless", "blissful", "bouncy", "fuzzy", "jolly", "peculiar", "nifty", "quirky",
  "wacky", "zany", "goofy", "perky", "spunky", "plucky", "cheeky", "sprightly", "whimsical", "giddy",
  "merry", "jovial", "chipper", "frisky", "spry", "kooky", "loopy", "wobbly", "bumbling", "fumbling",
  "snappy", "zippy", "peppy", "chirpy", "sassy", "cheery", "gleeful", "jaunty", "crimson", "amber",
  "indigo", "slate", "ivory", "scarlet", "auburn", "azure", "cobalt", "copper", "emerald", "golden",
  "russet", "saffron", "sienna", "teal", "violet", "amethyst", "beige", "bronze", "cerulean", "charcoal",
  "coral", "crimsoned", "ebony", "fawn", "flaxen", "jade", "lavender", "lilac", "magenta", "maroon",
  "ochre", "olive", "peach", "pewter", "rosy", "ruby", "sapphire", "silvery", "tawny", "topaz",
  "turquoise", "velvety", "verdant", "vermilion", "viridian", "velvet", "brittle", "glassy", "woolen", "marble",
  "satin", "silken", "leathery", "papery", "feathery", "downy", "fluffy", "fuzzed", "grainy", "gritty",
  "powdery", "rubbery", "rugged", "chalky", "crusty", "crumbly", "flaky", "frothy", "glossy", "gnarled",
  "knotty", "lacquered", "mossy", "oaken", "pebbly", "plush", "porous", "prickly", "ragged", "silty",
  "sinewy", "slimy", "spongy", "steely", "stony", "tinny", "waxen", "wiry", "woody", "crystalline",
  "tiny", "vast", "crooked", "round", "jagged", "squat", "towering", "spindly", "stubby", "lanky",
  "burly", "dainty", "colossal", "minute", "slender", "bulbous", "craggy", "curved", "cylindrical", "domed",
  "elongated", "flattened", "gaunt", "gigantic", "hulking", "immense", "lopsided", "massive", "narrow", "oblong",
  "petite", "plump", "pointed", "puny", "scrawny", "sprawling", "squarish", "tapered", "teeny", "titanic",
  "tubular", "twisted", "wee", "wide", "zigzag", "frosty", "balmy", "stormy", "misty", "sunlit",
  "wintry", "drizzly", "gusty", "blustery", "breezy", "chilly", "cloudy", "damp", "dewy", "foggy",
  "frozen", "glacial", "hazy", "humid", "muggy", "overcast", "parched", "rainy", "scorching", "sleety",
  "snowy", "steamy", "sultry", "sweltering", "thundery", "tropical", "windswept", "wintery", "sunny", "cloudless",
  "moonlit", "starlit", "tempestuous", "torrid", "arctic", "cosmic", "infinite", "quantum", "astral", "eternal",
  "boundless", "celestial", "ethereal", "fathomless", "galactic", "heavenly", "interstellar", "limitless", "lunar", "nebulous",
  "orbital", "planetary", "sidereal", "solar", "stellar", "sublime", "supernal", "transcendent", "unbounded", "abstract",
  "ephemeral", "immortal", "mythic", "mystic", "numinous", "oracular", "primordial", "spectral", "timeworn", "unearthly",
  "ancient", "antique", "arcane", "bygone", "fabled", "legendary", "olden", "quaint", "storied", "vintage",
  "rustic", "weathered", "worn", "wizened", "aged", "crumbling", "derelict", "dilapidated", "forgotten", "mossgrown",
  "ruined", "tumbledown", "venerable", "cobwebbed", "dusty", "musty", "ramshackle", "airy", "brisk", "buoyant",
  "calm", "carefree", "cozy", "dapper", "dashing", "dazzling", "delicate", "dewfresh", "dreamy", "dulcet",
  "elegant", "fancy", "fragrant", "gallant", "genial", "gentle", "glad", "graceful", "grand", "handsome",
  "honeyed", "jubilant", "keen", "kindly", "lively", "lofty", "lucid", "luminous", "lush", "mellow",
  "noble", "opulent", "pearly", "placid", "pleasant", "posh", "pristine", "quiet", "radiant", "refined",
  "regal", "serene", "shimmering", "sleek", "sprightful", "stately", "blithe", "sweet", "tender", "tranquil",
  "vivid", "wondrous", "zestful", "bashful", "bewildered", "bored", "cranky", "cross", "curious", "dazed",
  "dizzy", "dopey", "dour", "drained", "droopy", "fretful", "frazzled", "frantic", "gloomy", "grumpy",
  "jaded", "jittery", "jumpy", "languid", "leaden", "limp", "lethargic", "listful", "moody", "mopey",
  "morose", "peevish", "perplexed", "pining", "queasy", "sluggish", "somnolent", "sullen", "torpid", "woeful",
  "woozy", "yawning", "befuddled", "crestfallen", "despondent", "disheveled", "downcast", "dreamful", "fidgety", "flustered",
  "agile", "brave", "bright", "clever", "crafty", "cunning", "daring", "deft", "eager", "fearless",
  "fierce", "gallivanting", "heroic", "intrepid", "mighty", "nimble", "plinky", "quick", "rakish", "scrappy",
  "shrewd", "spirited", "stalwart", "swift", "tenacious", "valiant", "vigorous", "wily", "adventurous", "bold",
  "dauntless", "doughty", "sturdy", "gutsy", "mettlesome", "resolute", "stouthearted", "undaunted", "venturous", "glinting",
  "twinkling", "sparkling", "blazing", "burnished", "candlelit", "dappled", "flickering", "gilded", "glimmering", "glistening",
  "iridescent", "lambent", "molten", "opalescent", "phosphorescent", "prismatic", "resplendent", "scintillating", "shadowy", "smoldering",
  "sunbright", "translucent", "gleaming", "incandescent"
]);

export const NOUNS = clean([
  "toaster", "stapler", "kettle", "umbrella", "spreadsheet", "teapot", "thimble", "corkscrew", "mousepad", "doorknob",
  "lampshade", "spatula", "whisk", "ladle", "colander", "saucepan", "skillet", "strainer", "sieve", "trivet",
  "coaster", "napkin", "tablecloth", "placemat", "dustpan", "broom", "mop", "bucket", "sponge", "squeegee",
  "plunger", "wrench", "hammer", "screwdriver", "pliers", "ratchet", "sandpaper", "chisel", "mallet", "clamp",
  "scissors", "tweezers", "stencil", "paperclip", "pushpin", "thumbtack", "rubberband", "clipboard", "binder", "folder",
  "envelope", "postcard", "notebook", "journal", "calendar", "bookmark", "inkwell", "quill", "crayon", "marker",
  "eraser", "ruler", "compass", "protractor", "abacus", "calculator", "typewriter", "telephone", "doorbell", "mailbox",
  "birdhouse", "wheelbarrow", "watering", "flowerpot", "hammock", "lantern", "candle", "matchbox", "flashlight", "keychain",
  "wallet", "satchel", "backpack", "suitcase", "briefcase", "handbag", "lunchbox", "thermos", "canteen", "picnic",
  "blanket", "pillow", "cushion", "quilt", "mattress", "curtain", "doormat", "carpet", "rug", "wallpaper",
  "otter", "pangolin", "heron", "narwhal", "axolotl", "marmot", "badger", "beaver", "bobcat", "capybara",
  "chinchilla", "dormouse", "echidna", "ferret", "gecko", "gibbon", "hedgehog", "ibex", "jackal", "kestrel",
  "lemur", "lynx", "manatee", "meerkat", "mongoose", "newt", "ocelot", "okapi", "opossum", "panther",
  "platypus", "porpoise", "quokka", "raccoon", "salamander", "seahorse", "stingray", "tapir", "toucan", "wallaby",
  "walrus", "weasel", "wombat", "wolverine", "aardvark", "albatross", "alpaca", "anteater", "antelope", "armadillo",
  "barnacle", "buffalo", "bullfrog", "caribou", "cheetah", "chipmunk", "cormorant", "cougar", "coyote", "cricket",
  "dolphin", "dragonfly", "duckling", "falcon", "firefly", "flamingo", "gazelle", "giraffe", "goldfish", "grasshopper",
  "hamster", "hummingbird", "jaguar", "jellyfish", "kangaroo", "kingfisher", "koala", "ladybug", "leopard", "lobster",
  "magpie", "mallard", "mantis", "minnow", "mockingbird", "octopus", "ostrich", "panda", "parakeet", "peacock",
  "pelican", "penguin", "pheasant", "porcupine", "puffin", "reindeer", "rooster", "seagull", "skylark", "sparrow",
  "squirrel", "starling", "sturgeon", "swallow", "tadpole", "tortoise", "trout", "turtle", "vulture", "warbler",
  "woodpecker", "oblivion", "ennui", "monotony", "silence", "entropy", "solitude", "reverie", "nostalgia", "whimsy",
  "wonder", "yearning", "longing", "sorrow", "melancholy", "serenity", "tranquility", "euphoria", "languor", "torpor",
  "stillness", "quietude", "emptiness", "vacancy", "absence", "infinity", "eternity", "destiny", "fortune", "chance",
  "freedom", "wisdom", "courage", "patience", "kindness", "gratitude", "harmony", "balance", "mystery", "secret",
  "riddle", "enigma", "paradox", "echo", "shadow", "glimmer", "whisper", "murmur", "hush", "lull",
  "drift", "haze", "mirage", "illusion", "fantasy", "daydream", "slumber", "dawning", "twilight", "gloaming",
  "meadow", "glacier", "canyon", "thicket", "lagoon", "prairie", "marsh", "grove", "glade", "fjord",
  "delta", "estuary", "tundra", "savanna", "wetland", "heath", "moor", "fen", "bog", "dune",
  "ridge", "ravine", "gorge", "gully", "plateau", "mesa", "butte", "foothill", "summit", "valley",
  "hillside", "riverbank", "seashore", "shoreline", "coastline", "tidepool", "waterfall", "cascade", "brook", "creek",
  "stream", "rivulet", "spring", "pond", "lake", "oasis", "reef", "atoll", "island", "peninsula",
  "boulder", "pebble", "cavern", "grotto", "hollow", "clearing", "woodland", "forest", "rainforest", "jungle",
  "orchard", "vineyard", "wildflower", "fern", "blossom", "petal", "willow", "birch", "cedar", "maple",
  "nebula", "comet", "quasar", "eclipse", "horizon", "galaxy", "starlight", "moonbeam", "sunbeam", "aurora",
  "cosmos", "meteor", "asteroid", "planet", "satellite", "constellation", "supernova", "starburst", "stardust", "cosmonaut",
  "moonrise", "zenith", "nadir", "equinox", "solstice", "crescent", "corona", "nightfall", "daybreak", "sunrise",
  "sunset", "afterglow", "starfall", "skyline", "firmament", "biscuit", "marmalade", "dumpling", "custard", "pretzel",
  "muffin", "crumpet", "scone", "waffle", "pancake", "croissant", "baguette", "brioche", "focaccia", "sourdough",
  "doughnut", "cupcake", "brownie", "cookie", "macaroon", "meringue", "truffle", "praline", "caramel", "toffee",
  "fudge", "nougat", "marzipan", "gingerbread", "shortbread", "strudel", "cobbler", "trifle", "parfait", "sherbet",
  "popsicle", "lollipop", "gumdrop", "jellybean", "marshmallow", "porridge", "oatmeal", "granola", "pudding", "tapioca",
  "noodle", "ravioli", "dumplings", "wonton", "sushi", "tempura", "empanada", "quesadilla", "burrito", "taco",
  "falafel", "hummus", "pickle", "relish", "chutney", "ketchup", "mustard", "gravy", "cinnamon", "nutmeg",
  "paprika", "ginger", "vanilla", "honey", "molasses", "syrup", "jam", "jelly", "cubicle", "hallway",
  "lighthouse", "observatory", "bazaar", "atrium", "balcony", "corridor", "stairwell", "mezzanine", "veranda", "portico",
  "rotunda", "alcove", "foyer", "pantry", "cellar", "attic", "loft", "gazebo", "pavilion", "pagoda",
  "turret", "battlement", "drawbridge", "rampart", "parapet", "colonnade", "archway", "courtyard", "cloister", "sanctuary",
  "chapel", "cathedral", "monastery", "windmill", "watermill", "granary", "barn", "silo", "stable", "cottage",
  "cabin", "bungalow", "chalet", "villa", "manor", "mansion", "palace", "fortress", "citadel", "outpost",
  "harbor", "wharf", "pier", "dock", "jetty", "marina", "aqueduct", "viaduct", "tunnel", "bridge",
  "skyscraper", "tenement", "plaza", "promenade", "boulevard", "alleyway", "crossroads", "junction", "roundabout", "terminal",
  "depot", "station", "carousel", "ferriswheel", "bandstand", "amphitheater", "arena", "stadium", "colosseum", "planetarium",
  "aquarium", "conservatory", "greenhouse", "apiary", "aviary", "dovecote", "beacon", "monument", "obelisk", "fountain",
  "cannister", "decanter", "goblet", "chalice", "carafe", "tureen", "platter", "saucer", "teaspoon", "saltcellar",
  "candlestick", "chandelier", "sundial", "hourglass", "barometer", "metronome", "gramophone", "phonograph", "accordion", "harmonica",
  "tambourine", "kazoo", "ocarina", "zither", "mandolin", "banjo", "ukulele", "trombone", "trumpet", "clarinet",
  "harpsichord", "glockenspiel", "periscope", "kaleidoscope", "spyglass", "monocle", "spectacles", "goggles", "mitten", "scarf"
]);

export const SURNAMES = clean([
  "einstein", "turing", "curie", "lovelace", "hopper", "tesla", "darwin", "newton", "bohr", "hawking",
  "noether", "ramanujan", "euler", "gauss", "hypatia", "galileo", "kepler", "copernicus", "faraday", "maxwell",
  "feynman", "planck", "heisenberg", "schrodinger", "dirac", "fermi", "pauli", "rutherford", "thomson", "chadwick",
  "becquerel", "roentgen", "compton", "millikan", "oppenheimer", "sagan", "herschel", "huygens", "brahe", "laplace",
  "lagrange", "fourier", "pascal", "fermat", "leibniz", "cauchy", "riemann", "cantor", "hilbert", "poincare",
  "boole", "fibonacci", "pythagoras", "archimedes", "euclid", "ptolemy", "hubble", "chandrasekhar", "penzias", "wilson",
  "mendel", "linnaeus", "lamarck", "wallace", "pasteur", "koch", "fleming", "salk", "jenner", "lister",
  "harvey", "vesalius", "mendeleev", "lavoisier", "dalton", "avogadro", "boyle", "priestley", "arrhenius", "gibbs",
  "joule", "kelvin", "carnot", "helmholtz", "ohm", "ampere", "volta", "coulomb", "henry", "watt",
  "edison", "morse", "bell", "marconi", "wright", "whitney", "fulton", "goodyear", "gutenberg", "franklin",
  "tycho", "aristotle", "democritus", "ada", "babbage", "shannon", "neumann", "godel", "markov", "bayes",
  "bernoulli", "napier", "kovalevskaya", "germain", "banneker", "carver", "tyson", "goodall", "leakey", "fossey",
  "humboldt", "magellan", "columbus", "cook", "drake", "amundsen", "shackleton", "livingstone", "cousteau", "hillary",
  "armstrong", "gagarin", "ride", "jemison", "tereshkova", "aldrin"
]);

// Short joining words retained for the legacy long-name generator. They make a
// word-only slug read naturally but do not provide an access-control boundary.
export const CONNECTORS = clean([
  "of", "in", "by", "near", "beneath", "beyond", "amid", "under", "into",
  "through", "across", "beside", "atop", "within", "toward", "above", "below"
]);

const RESERVED = new Set(["p", "index", "404", ""]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_LENGTH = 63;

// A small mulberry32 PRNG. Cryptographic strength is NOT needed — names are
// cosmetic, not a secret — but a seedable generator makes tests deterministic.
// Returns a function yielding floats in [0, 1).
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Default randomness: uniform, unbiased picks via crypto.randomInt (still a Node
// builtin, so zero npm deps).
function cryptoRng() {
  return randomInt(0, 0x100000000) / 0x100000000;
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function pickDistinct(list, rng, notEqualTo) {
  for (let i = 0; i < 8; i += 1) {
    const value = pick(list, rng);
    if (value !== notEqualTo) return value;
  }
  return pick(list, rng);
}

// Name shapes, mixing flavors so the library reads with lots of variety.
const TEMPLATES = [
  (rng) => [pick(ADJECTIVES, rng), pick(NOUNS, rng)],                              // hollow-paperclip
  (rng) => [pick(ADVERBS, rng), pick(ADJECTIVES, rng), pick(NOUNS, rng)],          // dreamily-fading-casket
  (rng) => {                                                                       // hushed-restless-oblivion
    const first = pick(ADJECTIVES, rng);
    return [first, pickDistinct(ADJECTIVES, rng, first), pick(NOUNS, rng)];
  },
  (rng) => [pick(ADJECTIVES, rng), pick(SURNAMES, rng)],                           // nostalgic-curie
  (rng) => [pick(ADVERBS, rng), pick(ADJECTIVES, rng), pick(SURNAMES, rng)]        // quietly-restless-turing
];

// Generate one memorable name. Pass { template } to force a specific shape (0-4)
// and { rng } (e.g. makeRng(seed)) for deterministic output in tests.
export function generateName({ rng = cryptoRng, template } = {}) {
  if (template !== undefined && typeof TEMPLATES[template] !== "function") {
    throw new RangeError(`Invalid name template index: ${template}`);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const build = template === undefined ? pick(TEMPLATES, rng) : TEMPLATES[template];
    const name = build(rng).join("-");
    if (name.length <= MAX_LENGTH && !RESERVED.has(name) && DNS_LABEL.test(name)) {
      return name;
    }
  }
  // Always-valid fallback (two short words can never exceed the cap or collide
  // with a reserved single-segment slug).
  return `${pick(ADJECTIVES, rng)}-${pick(NOUNS, rng)}`;
}

// Generate a name that is not already taken. `isTaken(name)` should return true
// for any slug already in use. The huge library makes a clash unlikely, but if
// every reroll collides we escalate by appending another word — never a digit —
// so the result stays all-words and is guaranteed unique and terminating.
export function generateUniqueName(isTaken = () => false, { rng = cryptoRng, generate } = {}) {
  const gen = generate || (() => generateName({ rng }));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = gen();
    if (!isTaken(name)) return name;
  }
  let name = gen();
  for (let guard = 0; guard < 100; guard += 1) {
    if (!isTaken(name)) return name;
    const candidate = `${name}-${pick(NOUNS, rng)}`;
    name = candidate.length <= MAX_LENGTH ? candidate : gen();
  }
  if (!isTaken(name)) return name;
  // Never hand back a colliding slug — that would break the token-identity
  // contract (findPublication / revoke / sync). Exhausting the (huge) namespace
  // is a real, surfaceable error rather than a silent duplicate.
  throw new Error("generateUniqueName: unable to find a unique name after retries");
}

// Generate the historical long, word-only slug with no digits. This stays for
// compatibility tests; new unlisted links use link-policy's explicit 128-bit
// capability suffix because a memorable word sequence is not a privacy control.
export function generateUnguessableName({ rng = cryptoRng } = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const parts = [
      pick(ADJECTIVES, rng),
      pick(NOUNS, rng),
      pick(CONNECTORS, rng),
      pick(ADJECTIVES, rng),
      pick(NOUNS, rng)
    ];
    if (rng() < 0.5) parts.push(pick(NOUNS, rng));
    const name = parts.join("-");
    if (name.length <= MAX_LENGTH && !RESERVED.has(name) && DNS_LABEL.test(name)) {
      return name;
    }
  }
  // Always-valid fallback: five short-ish words keep the >=5-word contract while
  // never exceeding the cap or colliding with a reserved single-segment slug.
  return [
    pick(ADJECTIVES, rng),
    pick(NOUNS, rng),
    pick(CONNECTORS, rng),
    pick(ADJECTIVES, rng),
    pick(NOUNS, rng)
  ].join("-");
}
