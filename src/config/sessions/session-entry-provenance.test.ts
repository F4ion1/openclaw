import { describe, expect, it } from "vitest";
import {
  attributeDelegatedSessionCreator,
  inheritSessionCreationPolicy,
  inheritSessionGitContributorProfileIds,
  preserveCreationStamp,
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
  sessionIsolationProfileId,
  isMainGitContributorScope,
  inheritSpawnSessionOwner,
  sessionPersonalProfileId,
  type SessionActor,
  type SessionCreatedActor,
} from "./session-entry-provenance.js";

type Source = Parameters<typeof sessionPersonalProfileId>[0];
const creator: SessionCreatedActor = { type: "human", source: "profile", id: "profile-creator" };
const human = (id?: string, label?: string): SessionActor => ({ type: "human", id, label });
const spawningAgent: SessionCreatedActor = { type: "agent", id: "roboclaw" };

it("resolves personal profiles from assigned humans or authenticated creators only", () => {
  const cases: Array<[Source, string | undefined]> = [
    [
      { owner: { actor: human("profile-owner", "profile-other") }, createdActor: creator },
      "profile-owner",
    ],
    [{ createdActor: creator }, "profile-creator"],
    [
      { owner: { actor: { type: "agent", id: "profile-not-a-human" } }, createdActor: creator },
      "profile-creator",
    ],
    [
      {
        createdActor: {
          type: "human",
          source: "channel",
          id: "profile-creator",
          label: "profile-owner",
        },
      },
      undefined,
    ],
    [{ owner: { actor: human(undefined, "profile-owner") }, createdActor: creator }, undefined],
    [{ createdActor: { type: "human", source: "profile", label: "profile-creator" } }, undefined],
    [undefined, undefined],
    [{}, undefined],
    [
      {
        owner: { actor: { type: "agent", id: "profile-owner" } },
        createdActor: { type: "system", id: "profile-creator" },
      },
      undefined,
    ],
  ];
  for (const [source, expected] of cases) {
    expect(sessionPersonalProfileId(source), JSON.stringify(source)).toBe(expected);
  }
});

it("inherits only the requesting human's current owner, including canonical profile aliases", () => {
  const cases: Array<{
    source: Source;
    requester: string | undefined;
    actor: SessionActor;
    now?: number;
    resolve?: (profileId: string) => string | undefined;
  }> = [
    { source: { createdActor: creator }, requester: creator.id, actor: human(creator.id), now: 42 },
    {
      source: { owner: { actor: human("profile-owner") }, createdActor: creator },
      requester: "profile-owner",
      actor: human("profile-owner"),
      now: 42,
    },
    { source: { createdActor: creator }, requester: "profile-other", actor: spawningAgent },
    { source: { createdActor: creator }, requester: undefined, actor: spawningAgent },
    {
      source: { owner: { actor: human("profile-before-merge") }, createdActor: creator },
      requester: "profile-after-merge",
      actor: human("profile-after-merge"),
      now: 42,
      resolve: (id) => (id === "profile-before-merge" ? "profile-after-merge" : id),
    },
    {
      source: { owner: { actor: { type: "agent", id: "another-agent" } }, createdActor: creator },
      requester: creator.id,
      actor: spawningAgent,
    },
    {
      source: { createdActor: { type: "human", source: "channel", id: "discord-user" } },
      requester: "discord-user",
      actor: spawningAgent,
    },
  ];
  for (const { source, requester, actor, now, resolve } of cases) {
    expect(inheritSpawnSessionOwner(source, spawningAgent, requester, now, resolve)).toEqual({
      actor,
      assignedBy: spawningAgent,
      assignedAt: now ?? expect.any(Number),
    });
  }
});

const parent = {
  inheritedGitContributorProfileIds: ["prior-inherited"],
  participants: ["unrelated-a", "unrelated-b"].map((id) => ({
    identity: { type: "profile" as const, id },
    contributionCount: 1,
    firstPromptedAt: 1,
    lastPromptedAt: 1,
  })),
};

describe("Git contributor source scope", () => {
  it("uses the verified request, not a multiplexed main roster, for delegation", () => {
    const source = {
      agentId: "work",
      config: { session: { mainKey: "home" } },
      sessionKey: "agent:work:home",
    };
    expect(
      inheritSessionGitContributorProfileIds(parent, {
        ...source,
        requesterProfileId: "requester-c",
      }),
    ).toEqual(["requester-c"]);
    expect(inheritSessionGitContributorProfileIds(parent, source)).toBeUndefined();
    expect(
      inheritSessionGitContributorProfileIds(parent, {
        ...source,
        requesterProfileId: "requester-d",
      }),
    ).toEqual(["requester-d"]);
    expect(isMainGitContributorScope({ ...source, sessionKey: "agent:other:home" })).toBe(false);
    expect(
      isMainGitContributorScope({
        agentId: "work",
        config: { session: { scope: "global" } },
        sessionKey: "global",
      }),
    ).toBe(true);
  });

  it("preserves authorized collaborative task and nested-delegation credit", () => {
    const source = { agentId: "work", config: {}, sessionKey: "agent:work:dashboard:task" };
    const inheritedGitContributorProfileIds = inheritSessionGitContributorProfileIds(
      parent,
      source,
    );
    expect(inheritedGitContributorProfileIds).toEqual([
      "prior-inherited",
      "unrelated-a",
      "unrelated-b",
    ]);
    expect(
      inheritSessionGitContributorProfileIds(
        { inheritedGitContributorProfileIds },
        { ...source, sessionKey: "agent:work:subagent:child" },
      ),
    ).toEqual(inheritedGitContributorProfileIds);
    expect(
      inheritSessionGitContributorProfileIds({ ...parent, incognito: true }, source),
    ).toBeUndefined();
  });
});

describe("delegated human creators", () => {
  const config = { agents: { defaults: { experimental: { delegatedCreatorAttribution: true } } } };
  const actor: SessionCreatedActor = { type: "human", source: "profile", id: "isolation-owner" };

  it("keeps the legacy isolation actor while projecting the captured human creator", () => {
    const attributed = attributeDelegatedSessionCreator(actor, config, "requester");
    expect(attributed).toEqual({
      ...actor,
      delegatedBy: { type: "human", source: "profile", id: "requester" },
    });
    expect(resolveSessionCreatorActor(attributed)).toEqual({
      type: "human",
      source: "profile",
      id: "requester",
    });
    expect(sessionCreatorProfileId(attributed)).toBe("requester");
    expect(sessionIsolationProfileId(attributed)).toBe("isolation-owner");
    expect(actor).not.toHaveProperty("delegatedBy");
  });

  it("requires explicit opt-in and a captured human, not an assignee or execution agent", () => {
    for (const cfg of [
      {},
      { agents: { defaults: { experimental: { delegatedCreatorAttribution: false } } } },
    ]) {
      expect(attributeDelegatedSessionCreator(spawningAgent, cfg, "requester")).toEqual(
        spawningAgent,
      );
    }
    expect(attributeDelegatedSessionCreator(spawningAgent, config)).toEqual(spawningAgent);
    expect(attributeDelegatedSessionCreator(undefined, config, "requester")).toBeUndefined();
  });

  it("does not rewrite stored attribution when settings, assignment or proposed creator change", () => {
    const attributed = attributeDelegatedSessionCreator(actor, config, "requester");
    const stored = {
      createdActor: attributed,
      createdVia: "spawn" as const,
      createdAt: 1,
      sandbox: "required" as const,
    };
    expect(preserveCreationStamp({ ...stored, createdActor: creator }, stored)).toEqual(stored);
    expect(inheritSessionCreationPolicy(stored, spawningAgent)).toEqual({
      actor: attributed,
      sandbox: "required",
    });
    expect(sessionPersonalProfileId({ createdActor: attributed })).toBe("requester");
    expect(
      sessionPersonalProfileId({ createdActor: attributed, owner: { actor: human("assignee") } }),
    ).toBe("assignee");
  });
});
