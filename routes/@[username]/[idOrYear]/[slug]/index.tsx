import * as vocab from "@fedify/fedify/vocab";
import * as v from "@valibot/valibot";
import { eq, sql } from "drizzle-orm";
import { page } from "fresh";
import { ArticleMetadata } from "../../../../components/ArticleMetadata.tsx";
import { Msg } from "../../../../components/Msg.tsx";
import { PostExcerpt } from "../../../../components/PostExcerpt.tsx";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { Composer } from "../../../../islands/Composer.tsx";
import { kv } from "../../../../kv.ts";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource, updateArticle } from "../../../../models/article.ts";
import { renderMarkup } from "../../../../models/markup.ts";
import { createNote } from "../../../../models/note.ts";
import { isPostVisibleTo } from "../../../../models/post.ts";
import {
  type Account,
  type Actor,
  type ArticleSource,
  type Post,
  type PostMedium,
  postTable,
} from "../../../../models/schema.ts";
import { define } from "../../../../utils.ts";
import { NoteSourceSchema } from "../../index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
    );
    if (article == null) return ctx.next();
    if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const permalink = new URL(
      `/@${article.account.username}/${article.publishedYear}/${article.slug}`,
      ctx.state.canonicalOrigin,
    );
    if (
      ctx.state.account?.moderator &&
        ctx.url.searchParams.has("refresh") ||
      ctx.params.username !== article.account.username &&
        article.post.url !== permalink.href
    ) {
      await updateArticle(db, kv, ctx.state.fedCtx, article.id, {});
    }
    const articleUri = ctx.state.fedCtx.getObjectUri(
      vocab.Article,
      { id: article.id },
    );
    const content = await renderMarkup(
      db,
      ctx.state.fedCtx,
      article.id,
      article.content,
    );
    ctx.state.links.push(
      { rel: "canonical", href: permalink },
      {
        rel: "alternate",
        type: "application/activity+json",
        href: articleUri,
      },
    );
    const description = content.text; // FIXME: Summarize content
    ctx.state.metas.push(
      { name: "description", content: description },
      { name: "og:title", content: article.title },
      { name: "og:description", content: description },
      { name: "og:url", content: permalink },
      { name: "og:type", content: "article" },
      { name: "og:locale", content: article.language },
      {
        property: "og:image",
        content: new URL(
          `/@${article.account.username}/${article.publishedYear}/${article.slug}/og`,
          ctx.state.canonicalOrigin,
        ),
      },
      { property: "og:image:width", content: 1200 },
      { property: "og:image:height", content: 630 },
      {
        name: "article:published_time",
        content: article.published.toISOString(),
      },
      {
        name: "article:modified_time",
        content: article.updated.toISOString(),
      },
      { name: "article:author", content: article.account.name },
      { name: "article:author.username", content: article.account.username },
      ...article.tags.map((tag) => ({ name: "article:tag", content: tag })),
    );
    const comments = await db.query.postTable.findMany({
      with: {
        actor: true,
        media: true,
        shares: {
          where: ctx.state.account == null
            ? sql`false`
            : eq(postTable.actorId, ctx.state.account.actor.id),
        },
      },
      where: eq(postTable.replyTargetId, article.post.id),
      orderBy: postTable.published,
    });
    return page<ArticlePageProps>({
      article,
      articleIri: articleUri.href,
      comments,
      avatarUrl: await getAvatarUrl(article.account),
      contentHtml: content.html,
    }, {
      headers: {
        Link:
          `<${articleUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },

  async POST(ctx) {
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
    );
    if (article == null) return ctx.next();
    if (ctx.state.account == null) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const payload = await ctx.req.json();
    const parsed = await v.safeParseAsync(NoteSourceSchema, payload);
    if (!parsed.success) {
      return new Response(JSON.stringify(parsed.issues), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const disk = drive.use();
    const post = await createNote(db, kv, disk, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, article.post);
    if (post == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(post), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

interface ArticlePageProps {
  article: ArticleSource & { account: Account };
  articleIri: string;
  comments: (Post & { actor: Actor; media: PostMedium[]; shares: Post[] })[];
  avatarUrl: string;
  contentHtml: string;
}

export default define.page<typeof handler, ArticlePageProps>(
  function ArticlePage(
    {
      url,
      state,
      data: { article, articleIri, comments, avatarUrl, contentHtml },
    },
  ) {
    const authorHandle = `@${article.account.username}@${url.host}`;
    const postUrl =
      `/@${article.account.username}/${article.publishedYear}/${article.slug}`;
    return (
      <>
        <article>
          <h1 class="text-4xl font-bold" lang={article.language}>
            {article.title}
          </h1>
          <ArticleMetadata
            class="mt-4"
            authorUrl={`/@${article.account.username}`}
            authorName={article.account.name}
            authorHandle={authorHandle}
            authorAvatarUrl={avatarUrl}
            published={article.published}
            editUrl={state.account?.id === article.accountId
              ? `${postUrl}/edit`
              : null}
          />
          <div
            lang={article.language}
            class="prose dark:prose-invert mt-4 text-xl"
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          />
        </article>
        <div>
          <h1 class="text-3xl font-bold mt-10">
            <Msg $key="article.comments" count={comments.length} />
          </h1>
          {state.account == null
            ? (
              <p class="mt-4 leading-7">
                <Msg
                  $key="article.remoteCommentDescription"
                  permalink={
                    <span class="font-bold border-dashed border-b-[1px] select-all">
                      {articleIri}
                    </span>
                  }
                />
              </p>
            )
            : (
              <Composer
                class="mt-4"
                commentTarget={authorHandle}
                language={state.language}
                postUrl={postUrl}
                onPost="reload"
              />
            )}
          {comments.map((comment) => (
            <PostExcerpt
              key={comment.id}
              post={{ ...comment, sharedPost: null, replyTarget: null }}
            />
          ))}
        </div>
      </>
    );
  },
);
