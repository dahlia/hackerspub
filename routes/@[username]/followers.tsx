import { and, desc, eq, isNotNull } from "drizzle-orm";
import { page } from "fresh";
import { ActorList } from "../../components/ActorList.tsx";
import { Msg } from "../../components/Msg.tsx";
import { PageTitle } from "../../components/PageTitle.tsx";
import { db } from "../../db.ts";
import {
  type Account,
  accountTable,
  type Actor,
  followingTable,
} from "../../models/schema.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const { username } = ctx.params;
    if (username.includes("@")) return ctx.next();
    const account = await db.query.accountTable.findFirst({
      with: { actor: true },
      where: eq(accountTable.username, username),
    });
    if (account == null) return ctx.redirect(`/@${username}`);
    const followers = await db.query.followingTable.findMany({
      with: {
        follower: {
          with: { account: true },
        },
      },
      where: and(
        eq(followingTable.followeeId, account.actor.id),
        isNotNull(followingTable.accepted),
      ),
      orderBy: desc(followingTable.accepted),
    });
    ctx.state.title = ctx.state.t("profile.followerList.title", {
      name: account.name,
    });
    return page<FollowerListProps>({
      account,
      followers: followers.map((f) => f.follower),
    });
  },
});

interface FollowerListProps {
  account: Account;
  followers: (Actor & { account?: Account | null })[];
}

export default define.page<typeof handler, FollowerListProps>(
  function FollowerList({ data }) {
    return (
      <>
        <PageTitle>
          <Msg
            $key="profile.followerList.title"
            name={
              <a href={`/@${data.account.username}`} rel="top">
                {data.account.name}
              </a>
            }
          />
        </PageTitle>
        <ActorList actors={data.followers} />
      </>
    );
  },
);
