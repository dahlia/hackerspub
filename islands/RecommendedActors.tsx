import { escape } from "@std/html/entities";
import { useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Msg, Translation, TranslationSetup } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import type { Language } from "../i18n.ts";
import { renderCustomEmojis } from "../models/emoji.ts";
import type { Account, Actor } from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";
import { htmlXss } from "../models/xss.ts";
import { Link } from "./Link.tsx";

export interface RecommendedActorsProps {
  language: Language;
  actors: (Actor & { account?: Account | null })[];
  window: number;
}

export function RecommendedActors(
  { language, actors, window }: RecommendedActorsProps,
) {
  const [shownActors, setShownActors] = useState(actors.slice(0, window));
  const [hiddenActors, setHiddenActors] = useState(actors.slice(window));
  const [followingActors, setFollowingActors] = useState(new Set<Uuid>());
  return (
    <TranslationSetup language={language}>
      <Translation>
        {(t) => (
          <>
            <PageTitle subtitle={{ text: t("recommendedActors.description") }}>
              <Msg $key="recommendedActors.title" />
            </PageTitle>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {shownActors.map((actor, index) => (
                <div
                  key={actor.id}
                  class="bg-white dark:bg-stone-800 p-4 flex flex-col h-full"
                >
                  <div class="grow">
                    <div class="flex items-center space-x-4">
                      <img
                        src={actor.avatarUrl ??
                          "https://gravatar.com/avatar/?d=mp&s=128"}
                        alt={actor.name ?? undefined}
                        class="w-12 h-12"
                      />
                      <div>
                        <h2 class="text-lg font-semibold">
                          <Link
                            internalHref={actor.accountId == null
                              ? `/@${actor.username}@${actor.instanceHost}`
                              : `/@${actor.username}`}
                            href={actor.url ?? actor.iri}
                          >
                            {actor.name == null ? actor.username : (
                              <span
                                dangerouslySetInnerHTML={{
                                  __html: renderCustomEmojis(
                                    escape(actor.name),
                                    actor.emojis,
                                  ),
                                }}
                              />
                            )}
                          </Link>
                        </h2>
                        <p class="text-stone-500">
                          <Link
                            internalHref={actor.accountId == null
                              ? `/@${actor.username}@${actor.instanceHost}`
                              : `/@${actor.username}`}
                            href={actor.url ?? actor.iri}
                            class="select-all"
                          >
                            @{actor.username}@{actor.instanceHost}
                          </Link>
                        </p>
                      </div>
                    </div>
                    <div
                      class="mt-4 prose dark:prose-invert"
                      dangerouslySetInnerHTML={{
                        __html: renderCustomEmojis(
                          htmlXss.process(actor.bioHtml ?? ""),
                          actor.emojis,
                        ),
                      }}
                    />
                  </div>
                  <Button
                    class="mt-4 w-full grow-0"
                    disabled={followingActors.has(actor.id)}
                    onClick={() => {
                      setHiddenActors((hiddenActors) => hiddenActors.slice(1));
                      setFollowingActors((actors) => {
                        const s = new Set(actors);
                        s.add(actor.id);
                        return s;
                      });
                      fetch(
                        actor.accountId == null
                          ? `/@${actor.username}@${actor.instanceHost}/follow`
                          : `/@${actor.username}/follow`,
                        {
                          method: "POST",
                        },
                      ).then(() => {
                        setShownActors((actors) => [
                          ...actors.slice(0, index),
                          ...hiddenActors.slice(0, 1),
                          ...actors.slice(index + 1),
                        ]);
                        setFollowingActors((actors) => {
                          const s = new Set(actors);
                          s.delete(actor.id);
                          return s;
                        });
                      });
                    }}
                  >
                    {followingActors.has(actor.id)
                      ? <Msg $key="recommendedActors.following" />
                      : <Msg $key="recommendedActors.follow" />}
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </Translation>
    </TranslationSetup>
  );
}
