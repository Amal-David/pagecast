import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Per-page Open Graph card rendering. Runs entirely on the publisher's machine
// at publish time (satori → SVG → resvg WASM → PNG); the PNG is deployed as a
// static asset of the user's own Pages project, so page titles/descriptions
// never leave their infrastructure. satori and @resvg/resvg-wasm are pure
// JS/WASM (no native binaries) and are loaded lazily so CLI startup and
// non-publish paths pay nothing for them.

export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;
// Distinct name so we never collide with a user's own og.png; prepareSnapshot
// additionally skips generation when the file already exists in the source.
export const OG_CARD_FILENAME = "pagecast-og.png";

const TITLE_MAX_CHARS = 140;
const DESCRIPTION_MAX_CHARS = 200;

const FONTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "og-fonts"
);

// Palette lifted from the Pagecast landing page so cards read as one brand.
const INK = "#15171c";
const CREAM = "#faf9f6";
const CREAM_WARM = "#fdf1e6";
const ORANGE = "#ed6300";
const GRAY = "#6c7079";
const GRAY_DARK = "#3c3f47";

// The landing wordmark's icon (page + broadcast arcs) minus its <text>, so
// resvg never needs font resolution inside a nested SVG image.
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
  `<rect x="1" y="2.5" width="17" height="22" rx="3" fill="${INK}"/>` +
  `<path d="M5 9h9M5 13h9M5 17h6" stroke="${CREAM}" stroke-width="1.6" stroke-linecap="round"/>` +
  `<path d="M21.5 9.5a6 6 0 0 1 0 9" stroke="${ORANGE}" stroke-width="2" stroke-linecap="round" fill="none"/>` +
  `<path d="M24.5 6.5a10 10 0 0 1 0 15" stroke="${ORANGE}" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.5"/>` +
  "</svg>";
const MARK_DATA_URI = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`;

let rendererPromise = null;

async function loadRenderer() {
  const require = createRequire(import.meta.url);
  const [{ default: satori }, resvg] = await Promise.all([
    import("satori"),
    import("@resvg/resvg-wasm")
  ]);
  try {
    await resvg.initWasm(await fs.readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  } catch (error) {
    // initWasm is once-per-process; a parallel/earlier init is fine.
    if (!/already/i.test(String(error && error.message))) {
      throw error;
    }
  }
  const [fraunces, inter] = await Promise.all([
    fs.readFile(path.join(FONTS_DIR, "fraunces-600.ttf")),
    fs.readFile(path.join(FONTS_DIR, "inter-400.ttf"))
  ]);
  return {
    satori,
    Resvg: resvg.Resvg,
    fonts: [
      { name: "Fraunces", data: fraunces, weight: 600, style: "normal" },
      { name: "Inter", data: inter, weight: 400, style: "normal" }
    ]
  };
}

function getRenderer() {
  if (!rendererPromise) {
    rendererPromise = loadRenderer().catch((error) => {
      rendererPromise = null;
      throw error;
    });
  }
  return rendererPromise;
}

function collapseText(value, maxChars) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

function element(type, style, children) {
  const props = { style };
  if (children !== undefined) {
    props.children = children;
  }
  return { type, props };
}

function cardElement({ heading, blurb, siteHost, branded }) {
  const children = [];
  if (branded) {
    children.push(
      element("div", { display: "flex", alignItems: "center" }, [
        {
          type: "img",
          props: { src: MARK_DATA_URI, width: 40, height: 40, style: { marginRight: 14 } }
        },
        element(
          "div",
          { fontFamily: "Fraunces", fontWeight: 600, fontSize: 32, color: INK, letterSpacing: "-0.4px" },
          "Pagecast"
        )
      ])
    );
  }
  const headingSize = heading.length <= 34 ? 78 : heading.length <= 72 ? 64 : 52;
  children.push(
    element(
      "div",
      {
        display: "block",
        lineClamp: 3,
        marginTop: branded ? 48 : 24,
        maxWidth: 1010,
        fontFamily: "Fraunces",
        fontWeight: 600,
        fontSize: headingSize,
        lineHeight: 1.12,
        letterSpacing: "-1.5px",
        color: INK
      },
      heading
    )
  );
  if (blurb) {
    children.push(
      element(
        "div",
        {
          display: "block",
          lineClamp: 2,
          marginTop: 26,
          maxWidth: 950,
          fontSize: 28,
          lineHeight: 1.45,
          color: GRAY
        },
        blurb
      )
    );
  }
  if (siteHost) {
    children.push(
      element("div", { display: "flex", alignItems: "center", marginTop: "auto" }, [
        element("div", {
          width: 13,
          height: 13,
          borderRadius: 999,
          backgroundColor: ORANGE,
          marginRight: 14
        }),
        element("div", { fontSize: 25, color: GRAY_DARK }, siteHost)
      ])
    );
  }
  return element(
    "div",
    {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      padding: "54px 72px 56px",
      backgroundColor: CREAM,
      backgroundImage: `linear-gradient(135deg, ${CREAM} 55%, ${CREAM_WARM} 100%)`,
      borderTop: `10px solid ${ORANGE}`,
      fontFamily: "Inter"
    },
    children
  );
}

// Render a 1200×630 PNG card for a published page. Returns a Buffer, or null
// when there is no usable title or rendering fails for any reason (e.g. a
// title made only of glyphs the bundled fonts lack) — publishing must never
// fail over a cosmetic card, callers fall back to the static default image.
export async function renderOgCard({ title, description = "", siteHost = "", branded = true } = {}) {
  const heading = collapseText(title, TITLE_MAX_CHARS);
  if (!heading) {
    return null;
  }
  const blurb = collapseText(description, DESCRIPTION_MAX_CHARS);
  const host = collapseText(siteHost, 80);
  try {
    const { satori, Resvg, fonts } = await getRenderer();
    const svg = await satori(cardElement({ heading, blurb, siteHost: host, branded }), {
      width: OG_CARD_WIDTH,
      height: OG_CARD_HEIGHT,
      fonts
    });
    return Buffer.from(new Resvg(svg).render().asPng());
  } catch (error) {
    console.warn(`pagecast: per-page OG card render failed (${error?.message || error}); falling back to the default card image.`);
    return null;
  }
}
