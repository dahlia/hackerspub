import {
  type Context,
  type DocumentLoader,
  isActor,
  LanguageString,
  lookupObject,
  PUBLIC_COLLECTION,
  traverseCollection,
} from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import type { Database } from "../db.ts";
import { getAnnounce } from "../federation/objects.ts";
import {
  getPersistedActor,
  persistActor,
  syncActorFromAccount,
  toRecipient,
} from "./actor.ts";
import { toDate } from "./date.ts";
import { renderMarkup } from "./markup.ts";
import { postMedium } from "./medium.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  actorTable,
  type ArticleSource,
  type Following,
  type Instance,
  type Mention,
  mentionTable,
  type NewPost,
  type NoteMedium,
  type NoteSource,
  type Post,
  type PostMedium,
  postMediumTable,
  postTable,
  type PostVisibility,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "post"]);

export type PostObject = vocab.Article | vocab.Note | vocab.Question;

export function isPostObject(object: unknown): object is PostObject {
  return object instanceof vocab.Article || object instanceof vocab.Note ||
    object instanceof vocab.Question;
}

export async function syncPostFromArticleSource(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  articleSource: ArticleSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    };
  }
> {
  const actor = await syncActorFromAccount(
    db,
    kv,
    fedCtx,
    articleSource.account,
  );
  const rendered = await renderMarkup(
    db,
    fedCtx,
    articleSource.id,
    articleSource.content,
  );
  const url =
    `${fedCtx.origin}/@${articleSource.account.username}/${articleSource.publishedYear}/${
      encodeURIComponent(articleSource.slug)
    }`;
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Article, { id: articleSource.id }).href,
    type: "Article",
    visibility: "public",
    actorId: actor.id,
    articleSourceId: articleSource.id,
    name: articleSource.title,
    contentHtml: rendered.html,
    language: articleSource.language,
    tags: Object.fromEntries(
      articleSource.tags.map((
        tag,
      ) => [tag, `${fedCtx.origin}/tags/${encodeURIComponent(tag)}`]),
    ),
    url,
    updated: articleSource.updated,
    published: articleSource.published,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.articleSourceId,
      set: values,
      setWhere: eq(postTable.articleSourceId, articleSource.id),
    })
    .returning();
  return { ...rows[0], actor, articleSource };
}

export async function syncPostFromNoteSource(
  db: Database,
  kv: Keyv,
  disk: Disk,
  fedCtx: Context<void>,
  noteSource: NoteSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    media: NoteMedium[];
  },
  replyTarget?: { id: Uuid },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteMedium[];
    };
    mentions: Mention[];
    media: PostMedium[];
  }
> {
  const actor = await syncActorFromAccount(
    db,
    kv,
    fedCtx,
    noteSource.account,
  );
  // FIXME: Note should be rendered in a different way
  const rendered = await renderMarkup(
    db,
    fedCtx,
    noteSource.id,
    noteSource.content,
  );
  const url =
    `${fedCtx.origin}/@${noteSource.account.username}/${noteSource.id}`;
  const values: Omit<NewPost, "id"> = {
    iri: fedCtx.getObjectUri(vocab.Note, { id: noteSource.id }).href,
    type: "Note",
    visibility: noteSource.visibility,
    actorId: actor.id,
    noteSourceId: noteSource.id,
    replyTargetId: replyTarget?.id,
    contentHtml: rendered.html,
    language: noteSource.language,
    tags: {}, // TODO
    url,
    updated: noteSource.updated,
    published: noteSource.published,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.noteSourceId,
      set: values,
      setWhere: eq(postTable.noteSourceId, noteSource.id),
    })
    .returning();
  const post = rows[0];
  await db.delete(mentionTable).where(eq(mentionTable.postId, post.id));
  const mentionList = globalThis.Object.values(rendered.mentions);
  const mentions = mentionList.length > 0
    ? await db.insert(mentionTable).values(
      mentionList.map((actor) => ({
        postId: post.id,
        actorId: actor.id,
      })),
    ).returning()
    : [];
  await db.delete(postMediumTable).where(eq(postMediumTable.postId, post.id));
  const media = noteSource.media.length > 0
    ? await db.insert(postMediumTable).values(
      await Promise.all(noteSource.media.map(async (medium) => ({
        postId: post.id,
        index: medium.index,
        type: "image/webp" as const,
        url: await disk.getUrl(medium.key),
        alt: medium.alt,
        width: medium.width,
        height: medium.height,
      }))),
    ).returning()
    : [];
  return { ...post, actor, noteSource, mentions, media };
}

export async function persistPost(
  db: Database,
  post: PostObject,
  options: {
    actor?: Actor & { instance: Instance };
    replyTarget?: Post & { actor: Actor & { instance: Instance } };
    replies?: boolean;
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<Post & { actor: Actor & { instance: Instance } } | undefined> {
  if (post.id == null || post.attributionId == null || post.content == null) {
    logger.debug(
      "Missing required fields (id, attributedTo, content): {post}",
      { post },
    );
    return;
  }
  let actor =
    options.actor == null || options.actor.iri !== post.attributionId.href
      ? await getPersistedActor(db, post.attributionId)
      : options.actor;
  if (actor == null) {
    const apActor = await post.getAttribution(options);
    if (apActor == null) return;
    actor = await persistActor(db, apActor, options);
    if (actor == null) {
      logger.debug("Failed to persist actor: {actor}", { actor: apActor });
      return;
    }
  }
  const tags: Record<string, string> = {};
  const mentions = new Set<string>();
  const emojis: Record<string, string> = {};
  for await (const tag of post.getTags(options)) {
    if (tag instanceof vocab.Hashtag) {
      if (tag.name == null || tag.href == null) continue;
      tags[tag.name.toString().replace(/^#/, "")] = tag.href.href;
    } else if (tag instanceof vocab.Mention) {
      if (tag.href == null) continue;
      mentions.add(tag.href.href);
    } else if (tag instanceof vocab.Emoji) {
      if (tag.name == null) continue;
      const icon = await tag.getIcon(options);
      if (
        icon?.url == null ||
        icon.url instanceof vocab.Link && icon.url.href == null
      ) {
        continue;
      }
      emojis[tag.name.toString()] = icon.url instanceof URL
        ? icon.url.href
        : icon.url.href!.href;
    }
  }
  const attachments: vocab.Document[] = [];
  for await (const attachment of post.getAttachments(options)) {
    if (attachment instanceof vocab.Document) attachments.push(attachment);
  }
  let replyTarget: Post & { actor: Actor & { instance: Instance } } | undefined;
  if (post.replyTargetId != null) {
    replyTarget = options.replyTarget ??
      await getPersistedPost(db, post.replyTargetId);
    if (replyTarget == null) {
      const apReplyTarget = await post.getReplyTarget(options);
      if (!isPostObject(apReplyTarget)) return;
      replyTarget = await persistPost(db, apReplyTarget, options);
      if (replyTarget == null) return;
    }
  }
  const replies = options.replies ? await post.getReplies(options) : null;
  const shares = await post.getShares(options);
  const likes = await post.getLikes(options);
  const to = new Set(post.toIds.map((u) => u.href));
  const cc = new Set(post.ccIds.map((u) => u.href));
  const recipients = to.union(cc);
  const visibility: PostVisibility = to.has(PUBLIC_COLLECTION.href)
    ? "public"
    : cc.has(PUBLIC_COLLECTION.href)
    ? "unlisted"
    : actor.followersUrl != null && recipients.has(actor.followersUrl) &&
        mentions.isSubsetOf(recipients)
    ? "followers"
    : mentions.isSubsetOf(recipients)
    ? "direct"
    : "none";
  logger.debug(
    "Post visibility: {visibility} (drived from recipients {recipients} and " +
      "mentions {mentions}).",
    { visibility, recipients, to, cc, mentions },
  );
  const values: Omit<NewPost, "id"> = {
    iri: post.id.href,
    type: post instanceof vocab.Article
      ? "Article"
      : post instanceof vocab.Note
      ? "Note"
      : post instanceof vocab.Question
      ? "Question"
      : UNREACHABLE,
    visibility,
    actorId: actor.id,
    name: post.name?.toString(),
    contentHtml: post.content?.toString(),
    language: post.content instanceof LanguageString
      ? post.content.language.compact()
      : post.contents.length > 1 && post.contents[1] instanceof LanguageString
      ? post.contents[1].language.compact()
      : undefined,
    tags,
    emojis,
    url: post.url instanceof vocab.Link ? post.url.href?.href : post.url?.href,
    replyTargetId: replyTarget?.id,
    repliesCount: replies?.totalItems ?? 0,
    sharesCount: shares?.totalItems ?? 0,
    likesCount: likes?.totalItems ?? 0,
    updated: toDate(post.updated ?? post.published) ?? undefined,
    published: toDate(post.published) ?? undefined,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.iri,
      set: values,
      setWhere: eq(postTable.iri, post.id.href),
    })
    .returning();
  const persistedPost = { ...rows[0], actor };
  await db.delete(mentionTable).where(
    eq(mentionTable.postId, persistedPost.id),
  );
  if (mentions.size > 0) {
    const mentionedActors = await db.query.actorTable.findMany({
      where: inArray(actorTable.iri, [...mentions]),
    });
    for (const mentionedActor of mentionedActors) {
      mentions.delete(mentionedActor.iri);
    }
    if (mentions.size > 0) {
      for (const iri of mentions) {
        const apActor = await lookupObject(iri, options);
        if (!isActor(apActor)) continue;
        const actor = await persistActor(db, apActor, options);
        if (actor == null) continue;
        mentionedActors.push(actor);
      }
    }
    await db.insert(mentionTable)
      .values(
        mentionedActors.map((actor) => ({
          postId: persistedPost.id,
          actorId: actor.id,
        })),
      )
      .onConflictDoNothing()
      .execute();
  }
  await db.delete(postMediumTable).where(
    eq(postMediumTable.postId, persistedPost.id),
  );
  let i = 0;
  for (const attachment of attachments) {
    await postMedium(db, attachment, persistedPost.id, i);
    i++;
  }
  if (options.replies) {
    const replies = await post.getReplies(options);
    if (replies != null) {
      let repliesCount = 0;
      for await (
        const reply of traverseCollection(replies, {
          ...options,
          suppressError: true,
        })
      ) {
        if (!isPostObject(reply)) continue;
        await persistPost(db, reply, {
          ...options,
          actor,
          replyTarget: persistedPost,
        });
        repliesCount++;
      }
      if (persistedPost.repliesCount < repliesCount) {
        await db.update(postTable)
          .set({ repliesCount })
          .where(eq(postTable.id, persistedPost.id));
        persistedPost.repliesCount = repliesCount;
      }
    }
  }
  return persistedPost;
}

export async function persistSharedPost(
  db: Database,
  announce: vocab.Announce,
  options: {
    actor?: Actor & { instance: Instance };
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<
  Post & {
    actor: Actor & { instance: Instance };
    sharedPost: Post & { actor: Actor & { instance: Instance } };
  } | undefined
> {
  if (announce.id == null || announce.actorId == null) {
    logger.debug(
      "Missing required fields (id, actor): {announce}",
      { announce },
    );
    return;
  }
  let actor: Actor & { instance: Instance } | undefined =
    options.actor == null || options.actor.iri !== announce.actorId.href
      ? await getPersistedActor(db, announce.actorId)
      : options.actor;
  if (actor == null) {
    const apActor = await announce.getActor(options);
    if (apActor == null) return;
    actor = await persistActor(db, apActor, options);
    if (actor == null) return;
  }
  const object = await announce.getObject(options);
  if (!isPostObject(object)) return;
  const post = await persistPost(db, object, {
    ...options,
    replies: true,
  });
  if (post == null) return;
  const to = new Set(announce.toIds.map((u) => u.href));
  const cc = new Set(announce.ccIds.map((u) => u.href));
  const values: Omit<NewPost, "id"> = {
    iri: announce.id.href,
    type: post.type,
    visibility: to.has(PUBLIC_COLLECTION.href)
      ? "public"
      : cc.has(PUBLIC_COLLECTION.href)
      ? "unlisted"
      : actor.followersUrl != null &&
          (to.has(actor.followersUrl) || cc.has(actor.followersUrl))
      ? "followers"
      : "none",
    actorId: actor.id,
    sharedPostId: post.id,
    name: post.name,
    contentHtml: post.contentHtml,
    language: post.language,
    tags: {},
    emojis: post.emojis,
    sensitive: post.sensitive,
    url: post.url,
    updated: toDate(announce.updated ?? announce.published) ?? undefined,
    published: toDate(announce.published) ?? undefined,
  };
  const rows = await db.insert(postTable)
    .values({ id: generateUuidV7(), ...values })
    .onConflictDoUpdate({
      target: postTable.iri,
      set: values,
      setWhere: eq(postTable.iri, announce.id.href),
    })
    .returning();
  await updateSharesCount(db, post, 1);
  return { ...rows[0], actor, sharedPost: post };
}

export async function sharePost(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  account: Account & {
    emails: AccountEmail[];
    links: AccountLink[];
  },
  post: Post & { actor: Actor },
): Promise<Post> {
  const actor = await syncActorFromAccount(db, kv, fedCtx, account);
  const id = generateUuidV7();
  const posts = await db.insert(postTable).values({
    id,
    iri: fedCtx.getObjectUri(vocab.Announce, { id }).href,
    type: post.type,
    visibility: "public",
    actorId: actor.id,
    sharedPostId: post.id,
    name: post.name,
    contentHtml: post.contentHtml,
    language: post.language,
    tags: {},
    emojis: post.emojis,
    sensitive: post.sensitive,
    url: post.url,
  }).onConflictDoNothing().returning();
  if (posts.length < 1) {
    const share = await db.query.postTable.findFirst({
      where: and(
        eq(postTable.actorId, actor.id),
        eq(postTable.sharedPostId, post.id),
      ),
    });
    return share!;
  }
  const share = posts[0];
  post.sharesCount = await updateSharesCount(db, post, 1);
  share.sharesCount = post.sharesCount;
  const announce = getAnnounce(fedCtx, {
    ...share,
    sharedPost: post,
    actor: { ...actor, account },
    mentions: [],
  });
  await fedCtx.sendActivity(
    { identifier: account.id },
    "followers",
    announce,
    { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  await fedCtx.sendActivity(
    { identifier: account.id },
    toRecipient(post.actor),
    announce,
    { excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  return share;
}

export async function unsharePost(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  account: Account & {
    emails: AccountEmail[];
    links: AccountLink[];
  },
  sharedPost: Post & { actor: Actor },
): Promise<Post | undefined> {
  if (sharedPost.sharedPostId != null) return;
  const actor = await syncActorFromAccount(db, kv, fedCtx, account);
  const unshared = await db.delete(postTable).where(
    and(
      eq(postTable.actorId, actor.id),
      eq(postTable.sharedPostId, sharedPost.id),
    ),
  ).returning();
  if (unshared.length > 0) {
    sharedPost.sharesCount = await updateSharesCount(db, sharedPost, -1);
    const announce = getAnnounce(fedCtx, {
      ...unshared[0],
      actor,
      sharedPost,
      mentions: [],
    });
    const undo = new vocab.Undo({
      actor: fedCtx.getActorUri(account.id),
      object: announce,
      tos: announce.toIds,
      ccs: announce.ccIds,
    });
    await fedCtx.sendActivity(
      { identifier: account.id },
      "followers",
      undo,
      { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
    );
    await fedCtx.sendActivity(
      { identifier: account.id },
      toRecipient(sharedPost.actor),
      undo,
      { excludeBaseUris: [new URL(fedCtx.origin)] },
    );
  }
  return unshared[0];
}

export function getPersistedPost(
  db: Database,
  iri: URL,
): Promise<Post & { actor: Actor & { instance: Instance } } | undefined> {
  return db.query.postTable.findFirst({
    with: { actor: { with: { instance: true } } },
    where: eq(postTable.iri, iri.toString()),
  });
}

export function getPostByUsernameAndId(
  db: Database,
  username: string,
  id: Uuid,
  signedAccount?: Account & { actor: Actor },
): Promise<
  | Post & {
    actor: Actor & { followers: Following[] };
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
        media: PostMedium[];
        shares: Post[];
      }
      | null;
    replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
    mentions: Mention[];
    media: PostMedium[];
    shares: Post[];
  }
  | undefined
> {
  if (!username.includes("@")) return Promise.resolve(undefined);
  let host: string;
  [username, host] = username.split("@");
  return db.query.postTable.findFirst({
    with: {
      actor: {
        with: { followers: true },
      },
      sharedPost: {
        with: {
          actor: true,
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
          shares: {
            where: signedAccount == null
              ? sql`false`
              : eq(postTable.actorId, signedAccount.actor.id),
          },
        },
      },
      replyTarget: {
        with: { actor: true, media: true },
      },
      mentions: true,
      media: true,
      shares: {
        where: signedAccount == null
          ? sql`false`
          : eq(postTable.actorId, signedAccount.actor.id),
      },
    },
    where: and(
      inArray(
        postTable.actorId,
        db.select({ id: actorTable.id }).from(actorTable).where(
          and(
            eq(actorTable.username, username),
            eq(actorTable.instanceHost, host),
          ),
        ),
      ),
      eq(postTable.id, id),
    ),
  });
}

export async function deletePersistedPost(
  db: Database,
  iri: URL,
  actorIri: URL,
): Promise<void> {
  await db.delete(postTable).where(
    and(
      eq(postTable.iri, iri.toString()),
      inArray(
        postTable.actorId,
        db.select({ id: actorTable.id })
          .from(actorTable)
          .where(eq(actorTable.iri, actorIri.toString())),
      ),
      isNull(postTable.sharedPostId),
    ),
  );
}

export async function deleteSharedPost(
  db: Database,
  iri: URL,
  actorIri: URL,
): Promise<void> {
  const shares = await db.delete(postTable).where(
    and(
      eq(postTable.iri, iri.toString()),
      inArray(
        postTable.actorId,
        db.select({ id: actorTable.id })
          .from(actorTable)
          .where(eq(actorTable.iri, actorIri.toString())),
      ),
      isNotNull(postTable.sharedPostId),
    ),
  ).returning();
  if (shares.length < 1) return;
  const [share] = shares;
  if (share.sharedPostId == null) return;
  const sharedPost = await db.query.postTable.findFirst({
    where: eq(postTable.id, share.sharedPostId),
  });
  if (sharedPost == null) return;
  await updateSharesCount(db, sharedPost, -1);
}

export function isPostVisibleTo(
  post: Post & {
    actor: Actor & { followers: Following[] };
    mentions: Mention[];
  },
  actor?: { id: Uuid },
): boolean;
export function isPostVisibleTo(
  post: Post & {
    actor: Actor & { followers: (Following & { follower: Actor })[] };
    mentions: (Mention & { actor: Actor })[];
  },
  actor?: { iri: string },
): boolean;
export function isPostVisibleTo(
  post: Post & {
    actor: Actor & { followers: (Following & { follower?: Actor })[] };
    mentions: (Mention & { actor?: Actor })[];
  },
  actor?: { id: Uuid } | { iri: string },
): boolean {
  if (post.visibility === "public" || post.visibility === "unlisted") {
    return true;
  }
  if (actor == null) return false;
  if (
    "id" in actor && post.actor.id === actor.id ||
    "iri" in actor && post.actor.iri === actor.iri
  ) {
    return true;
  }
  if (post.visibility === "followers") {
    if ("id" in actor) {
      return post.actor.followers.some((follower) =>
        follower.followerId === actor.id
      ) || post.mentions.some((mention) => mention.actorId === actor.id);
    } else {
      return post.actor.followers.some((follower) =>
        follower.follower?.iri === actor.iri
      ) || post.mentions.some((mention) => mention.actor?.iri === actor.iri);
    }
  }
  if (post.visibility === "direct") {
    if ("id" in actor) {
      return post.mentions.some((mention) => mention.actorId === actor.id);
    } else {
      return post.mentions.some((mention) => mention.actor?.iri === actor.iri);
    }
  }
  return false;
}

export async function updateRepliesCount(
  db: Database,
  replyTargetId: Uuid,
): Promise<Post | undefined> {
  const rows = await db.update(postTable).set({
    repliesCount: sql`(
      SELECT count(*)
      FROM ${postTable}
      WHERE ${postTable.replyTargetId} = ${replyTargetId}
    )`,
  }).where(eq(postTable.id, replyTargetId)).returning();
  return rows[0];
}

export async function updateSharesCount(
  db: Database,
  post: Post,
  delta: number,
): Promise<number> {
  const sharesCount = post.sharesCount + delta;
  const cnt = await db.select({ count: count() })
    .from(postTable)
    .where(eq(postTable.sharedPostId, post.id));
  if (sharesCount <= cnt[0].count) {
    await db.update(postTable)
      .set({ sharesCount: cnt[0].count })
      .where(eq(postTable.id, post.id));
    post.sharesCount = cnt[0].count;
    return cnt[0].count;
  }
  return sharesCount;
}

const UNREACHABLE: never = undefined!;
