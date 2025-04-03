import { type Context, type DocumentLoader, isActor } from "@fedify/fedify";
import type * as vocab from "@fedify/fedify/vocab";
import { mention } from "@fedify/markdown-it-mention";
import { getLogger } from "@logtape/logtape";
import { titlePlugin as title } from "@mdit-vue/plugin-title";
import cjkBreaks from "@searking/markdown-it-cjk-breaks";
import shiki from "@shikijs/markdown-it";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
  transformerRemoveNotationEscape,
} from "@shikijs/transformers";
import { deadline } from "@std/async/deadline";
import { encodeAscii85 } from "@std/encoding/ascii85";
import { ASCII_DIACRITICS, slugify } from "@std/text/unstable-slugify";
import { load } from "cheerio";
import { arrayOverlaps, eq } from "drizzle-orm";
import katex from "katex";
import type Keyv from "keyv";
import createMarkdownIt from "markdown-it";
import abbr from "markdown-it-abbr";
import anchor from "markdown-it-anchor";
import deflist from "markdown-it-deflist";
import footnote from "markdown-it-footnote";
import admonition from "markdown-it-github-alerts";
import graphviz from "markdown-it-graphviz";
import texmath from "markdown-it-texmath";
import toc from "markdown-it-toc-done-right";
import type { Database } from "../db.ts";
import { persistActor, persistActorsByHandles } from "./actor.ts";
import { sanitizeExcerptHtml, sanitizeHtml, stripHtml } from "./html.ts";
import { type Actor, actorTable } from "./schema.ts";

const logger = getLogger(["hackerspub", "models", "markup"]);

const KV_NAMESPACE = "markup";
const KV_CACHE_VERSION = "2025-03-29";

let tocTree: InternalToc = { l: 0, n: "", c: [] };

let md = createMarkdownIt({ html: true, linkify: true })
  .use(abbr)
  .use(admonition)
  .use(anchor, {
    slugifyWithState(title: string, state: { env: Env }) {
      return slugifyTitle(title, state.env.docId);
    },
    permalink: anchor.permalink.linkInsideHeader({
      symbol: `<span aria-hidden="true" title="Link to this section"></span>`,
      placement: "after",
    }),
  })
  .use(cjkBreaks)
  .use(deflist)
  .use(footnote)
  .use(graphviz)
  .use(mention, {
    localDomain(_bareHandle: string, env: Env) {
      return env.localDomain;
    },
    link(handle: string, env: Env) {
      const actor = env.mentionedActors[handle];
      if (actor == null) return null;
      return actor.url ?? actor.iri;
    },
    linkAttributes: (handle: string, env: Env) => {
      const actor = env.mentionedActors[handle];
      if (actor == null) return {};
      return {
        class: "u-url mention bg-stone-300 rounded-lg p-1",
        title: actor.name ?? handle,
        "data-username": actor.username,
        "data-host": actor.instanceHost,
        "data-id": actor.id,
        "data-iri": actor.iri,
      };
    },
  })
  .use(texmath, {
    engine: katex,
    katexOptions: {
      output: "mathml",
      throwOnError: false,
    },
  })
  .use(title)
  .use(toc, {
    placeholder: `--${crypto.randomUUID()}--`.toUpperCase(),
    callback(_html: string, ast: InternalToc) {
      tocTree = ast;
    },
  });

// Lazy load Shiki to avoid blocking the startup time
let shikiLoaded = false;
let loadingShiki = new Promise<void>((resolve) =>
  setTimeout(() => {
    loadingShiki = shiki({
      themes: {
        light: "vitesse-light",
        dark: "vitesse-dark",
      },
      transformers: [
        transformerNotationDiff({ matchAlgorithm: "v3" }),
        transformerNotationHighlight({ matchAlgorithm: "v3" }),
        transformerMetaHighlight(),
        transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
        transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
        transformerMetaWordHighlight(),
        transformerNotationFocus({ matchAlgorithm: "v3" }),
        transformerRemoveNotationEscape(),
      ],
    }).then((shiki) => {
      md = md.use(shiki);
      shikiLoaded = true;
      resolve();
    });
  }, 500)
);

export interface RenderedMarkup {
  html: string;
  excerptHtml: string;
  text: string;
  title: string;
  toc: Toc[];
  mentions: Record<string, Actor>;
}

interface Env {
  docId?: string | null;
  title: string;
  localDomain: string;
  mentionedActors: Record<string, Actor>;
}

export interface RenderMarkupOptions {
  kv?: Keyv | null;
  docId?: string | null;
  refresh?: boolean;
}

export async function renderMarkup(
  db: Database,
  fedCtx: Context<void>,
  markup: string,
  options: RenderMarkupOptions = {},
): Promise<RenderedMarkup> {
  let cacheKey: string | undefined;
  if (options.kv != null) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${JSON.stringify(options.docId ?? null)}\n${markup}`,
      ),
    );
    cacheKey = `${KV_NAMESPACE}/${KV_CACHE_VERSION}/markup/${
      encodeAscii85(digest)
    }`;
    if (!options.refresh) {
      const cached = await options.kv.get<RenderedMarkup>(cacheKey);
      if (cached != null) return cached;
    }
  }
  const localDomain = new URL(fedCtx.canonicalOrigin).host;
  const tmpMd = createMarkdownIt().use(mention, {
    localDomain() {
      return localDomain;
    },
  });
  const tmpEnv: { mentions: string[] } = { mentions: [] };
  tmpMd.render(markup, tmpEnv);
  const mentions = new Set(tmpEnv.mentions);
  const mentionedActors = await persistActorsByHandles(db, fedCtx, [
    ...mentions,
  ]);
  if (!shikiLoaded) await loadingShiki;
  const env: Env = {
    docId: options.docId,
    title: "",
    localDomain,
    mentionedActors,
  };
  const rawHtml = md.render(markup, env)
    .replaceAll('<?xml version="1.0" encoding="UTF-8" standalone="no"?>', "")
    .replaceAll(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n' +
        ' "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      "",
    );
  const html = sanitizeHtml(rawHtml);
  const excerptHtml = sanitizeExcerptHtml(rawHtml);
  const text = stripHtml(rawHtml);
  const toc = toToc(tocTree, options.docId);
  const rendered: RenderedMarkup = {
    html,
    excerptHtml,
    text,
    title: env.title,
    toc: toc.level < 1 ? toc.children : [toc],
    mentions: mentionedActors,
  };
  if (options.kv != null && cacheKey != null) {
    await options.kv.set(cacheKey, rendered);
  }
  return rendered;
}

function slugifyTitle(title: string, docId?: string | null): string {
  return (docId == null ? "" : docId + "--") +
    slugify(title, { strip: ASCII_DIACRITICS });
}

interface InternalToc {
  l: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  n: string;
  c: InternalToc[];
}

export interface Toc {
  id: string;
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  children: Toc[];
}

function toToc(toc: InternalToc, docId?: string | null): Toc {
  return {
    id: slugifyTitle(toc.n.trimStart(), docId),
    level: toc.l,
    title: toc.n.trimStart(),
    children: toc.c.map((t) => toToc(t, docId)),
  };
}

export interface ExtractMentionsFromHtmlOptions {
  contextLoader?: DocumentLoader;
  documentLoader?: DocumentLoader;
  kv?: Keyv;
}

export async function extractMentionsFromHtml(
  db: Database,
  fedCtx: Context<void>,
  html: string,
  options: ExtractMentionsFromHtmlOptions = {},
): Promise<{ actor: Actor }[]> {
  let cacheKey: string | undefined;
  if (options.kv != null) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(html),
    );
    cacheKey = `${KV_NAMESPACE}/${KV_CACHE_VERSION}/mentions/${
      encodeAscii85(digest)
    }`;
    const cached = await options.kv.get<Actor[]>(cacheKey);
    if (cached) return cached.map((actor) => ({ actor }));
  }
  const $ = load(html, null, false);
  const mentionHrefs = new Set<string>();
  $("a.mention[href]:not(.hashtag)").each((_, el) => {
    const href = $(el).attr("href");
    if (href != null) mentionHrefs.add(href);
  });
  if (mentionHrefs.size < 1) return [];
  const actors = await db.query.actorTable.findMany({
    where: {
      OR: [
        { iri: { in: [...mentionHrefs] } },
        { url: { in: [...mentionHrefs] } },
        { RAW: (table) => arrayOverlaps(table.aliases, [...mentionHrefs]) },
      ],
    },
  });
  for (const actor of actors) {
    mentionHrefs.delete(actor.iri);
    if (actor.url != null) mentionHrefs.delete(actor.url);
    for (const alias of actor.aliases) mentionHrefs.delete(alias);
  }
  if (mentionHrefs.size < 1) return actors.map((actor) => ({ actor }));
  const mentionedUrls = [...mentionHrefs];
  logger.debug(
    "There are mentions to actors that are not persisted: {mentionedUrls}",
    { mentionedUrls },
  );
  const promises = mentionedUrls.map(async (href) => {
    try {
      return [
        href,
        await deadline(fedCtx.lookupObject(href, options), 3000),
      ] as [
        string,
        vocab.Object | null,
      ];
    } catch (_) {
      return null;
    }
  });
  for (const pair of await Promise.all(promises)) {
    if (pair == null) continue;
    const [href, object] = pair;
    if (!isActor(object)) continue;
    let actor = await persistActor(db, fedCtx, object, {
      ...options,
      outbox: false,
    });
    if (actor == null) continue;
    if (actor.iri !== href && !actor.aliases.includes(href)) {
      const aliases = [...actor.aliases, href];
      await db.update(actorTable)
        .set({ aliases })
        .where(eq(actorTable.id, actor.id));
      actor = { ...actor, aliases };
    }
    actors.push(actor);
  }
  if (options.kv != null && cacheKey != null) {
    await options.kv.set(cacheKey, actors);
  }
  return actors.map((actor) => ({ actor }));
}
