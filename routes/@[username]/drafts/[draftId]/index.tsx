import * as v from "@valibot/valibot";
import { and, eq } from "drizzle-orm";
import { page } from "fresh";
import { db } from "../../../../db.ts";
import { updateArticleDraft } from "../../../../models/article.ts";
import { define } from "../../../../utils.ts";
import { accountTable, articleDraftTable } from "../../../../models/schema.ts";
import { validateUuid } from "../../../../models/uuid.ts";
import { Editor } from "../../../../islands/Editor.tsx";

const TagSchema = v.pipe(v.string(), v.regex(/^[^\s,]+$/));

const ArticleDraftSchema = v.object({
  title: v.pipe(v.optional(v.string(), ""), v.trim()),
  content: v.optional(v.string(), ""),
  tags: v.optional(v.array(TagSchema), []),
});

export const handler = define.handlers({
  async GET(ctx) {
    if (!validateUuid(ctx.params.draftId)) return ctx.next();
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.id, ctx.state.session.accountId),
    });
    if (account == null || account.username != ctx.params.username) {
      return ctx.next();
    }
    const draft = await db.query.articleDraftTable.findFirst({
      where: and(
        eq(articleDraftTable.id, ctx.params.draftId),
        eq(articleDraftTable.accountId, account.id),
      ),
    });
    ctx.state.withoutMain = true;
    return page<DraftPageProps>(
      draft ?? {
        title: "",
        content: "",
        tags: [],
      },
    );
  },

  async PUT(ctx) {
    if (!validateUuid(ctx.params.draftId)) return ctx.next();
    if (ctx.state.session == null) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, ctx.params.username),
    });
    if (account?.id !== ctx.state.session.accountId) return ctx.next();
    const data = await ctx.req.json();
    const result = v.safeParse(ArticleDraftSchema, data);
    if (!result.success) {
      return new Response(
        JSON.stringify(result.issues),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const draft = await updateArticleDraft(db, {
      ...result.output,
      id: ctx.params.draftId,
      accountId: ctx.state.session.accountId,
    });
    return new Response(
      JSON.stringify(draft),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});

interface DraftPageProps {
  title: string;
  content: string;
  tags: string[];
}

export default define.page<typeof handler, DraftPageProps>(
  function DraftPage({ url, data }) {
    return (
      <main class="w-full h-[calc(100vh-3.75rem)]">
        <Editor
          class="w-full h-full"
          previewUrl={new URL("/api/preview", url).href}
          draftUrl={url.href}
          defaultTitle={data.title}
          defaultContent={data.content}
          defaultTags={data.tags}
        />
      </main>
    );
  },
);