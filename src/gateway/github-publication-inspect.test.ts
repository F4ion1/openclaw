// Keep external GitHub I/O synthetic while exercising registered admission and current profile state.
// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness, SESSION_ID, SESSION_KEY } from "./github-publication.test-support.js";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { SessionGitHubPullRequestInspectResultSchema } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  syncCanonicalGitHubIdentity,
  ensureCanonicalEnterpriseGitHubProfile,
  linkCanonicalUserProfileEmail,
} from "../state/user-profile-writes.js";
import { createRequesterPolicyFixture } from "./github-publication-requester.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const mocks = githubPublicationTestMocks();
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

async function fixture(options: { linked?: boolean; host?: string } = {}) {
  const f = await createRequesterPolicyFixture({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
  const host = options.host ?? "github.com";
  const config = { ...f.config, gateway: { ...f.config.gateway, github: { host } } };
  setRuntimeConfigSnapshot(config);
  if (options.linked !== false) {
    if (host === "github.com") {
      await syncCanonicalGitHubIdentity({
        identity: { accountId: 101, login: "contributor" },
        authenticationAlias: { kind: "email", email: "publication-guest@example.test" },
      });
    } else {
      await ensureCanonicalEnterpriseGitHubProfile(
        `github:${host}:101`,
        "Contributor",
        {},
        { login: "contributor" },
      );
      await linkCanonicalUserProfileEmail(`github:${host}:101`, f.guestProfile);
    }
  }
  mocks.prepareIdentity.mockResolvedValue({
    source: "system-detected",
    host,
    env: {},
    account: { accountId: 42, login: "publisher" },
  });
  const baseRepo = {
    id: 10,
    full_name: "example/repository",
    private: false,
    archived: false,
    owner: { type: "Organization" },
    permissions: { push: true },
  };
  const fork = {
    id: 20,
    full_name: "contributor/repository",
    private: false,
    archived: false,
    owner: { type: "User" },
    permissions: { push: false as boolean | undefined },
  };
  const pr = {
    number: 7,
    html_url: `https://${host}/example/repository/pull/7`,
    user: { id: 101, login: "contributor" },
    state: "open",
    draft: false,
    merged: false,
    maintainer_can_modify: true,
    base: { repo: baseRepo, ref: "release", sha: BASE },
    head: { repo: fork as typeof fork | typeof baseRepo | null, ref: "topic/existing", sha: HEAD },
  };
  const branch = { name: "topic/existing", commit: { sha: HEAD }, protected: false };
  let accessId = 101;
  let access = "read";
  let beforeRead: ((endpoint: string) => Promise<void>) | undefined;
  const requests: string[][] = [];
  mocks.runCommand.mockImplementation(async (argv: string[]) => {
    requests.push(argv);
    if (argv[0] !== "gh" || !argv.includes("GET")) {
      throw new Error("Inspection attempted a non-read command");
    }
    const endpoint = argv.at(-1)!;
    await beforeRead?.(endpoint);
    const value =
      endpoint === "repos/example/repository"
        ? baseRepo
        : endpoint === "repos/contributor/repository"
          ? fork
          : endpoint === "repos/example/repository/pulls/7"
            ? pr
            : endpoint.startsWith("user/")
              ? { id: Number(endpoint.slice(5)), login: "contributor" }
              : endpoint.endsWith("/collaborators/contributor/permission")
                ? { permission: access, user: { id: accessId } }
                : endpoint.includes("/branches/")
                  ? branch
                  : undefined;
    return value ? commandResult(JSON.stringify(value)) : commandResult("", 1);
  });
  const invoke = async (args: Record<string, unknown> = {}, raw = false) => {
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: randomUUID(), method, params },
        client: f.guestSource.client,
        context: f.guestSource.context as GatewayRequestContext,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error.message);
      }
      return result as T;
    };
    const input = { action: "inspect_pr", pullRequestUrl: pr.html_url, ...args };
    return await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: SESSION_KEY },
      async () =>
        raw
          ? await callGateway("sessions.github.action", { sessionKey: SESSION_KEY, ...input })
          : (await createGitHubPublishTool({ callGateway }).execute("inspect", input)).details,
    );
  };
  return {
    ...f,
    pr,
    baseRepo,
    fork,
    branch,
    requests,
    invoke,
    onRead(callback: (endpoint: string) => Promise<void>) {
      beforeRead = callback;
    },
    setAccess(permission: string, id = 101) {
      access = permission;
      accessId = id;
    },
  };
}

describe("own PR inspection through the admitted agent tool and Gateway", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
  });

  it.each(["same repository", "fork"])(
    "returns canonical %s identity without a receipt or writes",
    async (variant) => {
      const f = await fixture();
      if (variant === "same repository") {
        f.pr.head.repo = f.baseRepo;
      }
      const before = loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY });
      const result = await f.invoke();
      expect(Value.Check(SessionGitHubPullRequestInspectResultSchema, result)).toBe(true);
      expect(result).toMatchObject({
        url: "https://github.com/example/repository/pull/7",
        host: "github.com",
        number: 7,
        author: { accountId: 101, login: "contributor" },
        state: "open",
        base: {
          repository: "example/repository",
          repositoryId: 10,
          branch: "release",
          commit: BASE,
        },
        head: {
          repository: variant === "fork" ? "contributor/repository" : "example/repository",
          repositoryId: variant === "fork" ? 20 : 10,
          branch: "topic/existing",
          commit: HEAD,
        },
        continuation: {
          status: "permission_observed",
          reason: variant === "fork" ? "maintainer_edits" : "head_repository_write",
        },
      });
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY })).toEqual(
        before,
      );
      expect(f.requests.every((args) => args[0] === "gh" && args.includes("GET"))).toBe(true);
      expect(f.externalWrites).toEqual([]);
    },
  );

  it("accepts another verified linked account without depending on the primary credit choice", async () => {
    const f = await fixture();
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 202, login: "secondary" },
      authenticationAlias: { kind: "email", email: "secondary@example.test" },
    });
    await linkCanonicalUserProfileEmail("secondary@example.test", f.guestProfile);
    f.pr.user = { id: 202, login: "secondary" };
    expect(await f.invoke()).toMatchObject({ author: { accountId: 202, login: "secondary" } });
  });

  it.each(["unlinked", "wrong author"])("rejects %s without exposing PR data", async (variant) => {
    const f = await fixture({ linked: variant !== "unlinked" });
    if (variant === "wrong author") {
      f.pr.user.id = 999;
    }
    await expect(f.invoke()).rejects.toThrow(
      variant === "unlinked" ? "Link a verified" : "could not be verified as yours",
    );
    if (variant === "unlinked") {
      expect(f.requests).toEqual([]);
    }
    expect(f.requests.some((args) => args.at(-1)?.includes("/branches/"))).toBe(false);
  });

  it.each(["role", "linked identity", "publisher", "session"])(
    "rejects %s revocation during the PR read",
    async (change) => {
      const f = await fixture();
      let entered = false;
      f.onRead(async (endpoint) => {
        if (!endpoint.endsWith("/pulls/7")) {
          return;
        }
        entered = true;
        if (change === "role") {
          await f.revoke();
        } else if (change === "linked identity") {
          await linkCanonicalUserProfileEmail(
            "publication-guest@example.test",
            f.maintainerProfile,
          );
        } else if (change === "publisher") {
          mocks.matchesIdentity.mockReturnValue(false);
        } else {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: SESSION_KEY },
            { lifecycleRevision: randomUUID() },
          );
        }
      });
      await expect(f.invoke()).rejects.toThrow();
      expect(entered).toBe(true);
      expect(f.requests.some((args) => args.at(-1)?.includes("/branches/"))).toBe(false);
    },
  );

  it.each(["none", "wrong id", "read"])(
    "qualifies private repository access (%s) before reading the PR",
    async (permission) => {
      const f = await fixture();
      f.baseRepo.private = true;
      f.setAccess(permission === "none" ? "none" : "read", permission === "wrong id" ? 999 : 101);
      if (permission === "read") {
        expect(await f.invoke()).toMatchObject({ author: { accountId: 101 } });
        const endpoints = f.requests.map((args) => args.at(-1)!);
        expect(
          endpoints.indexOf("repos/example/repository/collaborators/contributor/permission"),
        ).toBeLessThan(endpoints.indexOf("repos/example/repository/pulls/7"));
      } else {
        await expect(f.invoke()).rejects.toThrow("could not be verified as yours");
        expect(f.requests.some((args) => args.at(-1)?.endsWith("/pulls/7"))).toBe(false);
      }
    },
  );

  it("does not expose a private head after the author loses its access", async () => {
    const f = await fixture();
    f.fork.private = true;
    f.setAccess("none");
    await expect(f.invoke()).rejects.toThrow("could not be verified as yours");
    expect(f.requests.some((args) => args.at(-1)?.includes("/branches/"))).toBe(false);
  });

  it.each([
    ["closed", "blocked", "closed"],
    ["deleted head", "blocked", "head_unavailable"],
    ["missing permission", "blocked", "no_head_permission"],
    ["protected", "unknown", "protected_branch"],
    ["advanced", "unknown", "head_changed"],
    ["archived", "blocked", "repository_archived"],
    ["unknown permissions", "unknown", "permission_unavailable"],
  ])(
    "reports %s without claiming continuation is guaranteed",
    async (condition, status, reason) => {
      const f = await fixture();
      if (condition === "closed") {
        f.pr.state = "closed";
      }
      if (condition === "deleted head") {
        f.pr.head.repo = null;
      }
      if (condition === "missing permission") {
        f.pr.maintainer_can_modify = false;
      }
      if (condition === "protected") {
        f.branch.protected = true;
      }
      if (condition === "advanced") {
        f.branch.commit.sha = "c".repeat(40);
      }
      if (condition === "archived") {
        f.fork.archived = true;
      }
      if (condition === "unknown permissions") {
        f.fork.permissions.push = undefined;
        f.pr.maintainer_can_modify = false;
      }
      expect(await f.invoke()).toMatchObject({ continuation: { status, reason } });
    },
  );

  it("keeps enterprise account IDs scoped to the configured host", async () => {
    const f = await fixture({ host: "git.example.test" });
    expect(await f.invoke()).toMatchObject({
      host: "git.example.test",
      author: { accountId: 101 },
    });
    expect(
      f.requests.every((args) => args[args.indexOf("--hostname") + 1] === "git.example.test"),
    ).toBe(true);
    await expect(
      f.invoke({ pullRequestUrl: "https://github.com/example/repository/pull/7" }),
    ).rejects.toThrow("configured GitHub host");
    setRuntimeConfigSnapshot({
      ...f.config,
      gateway: { ...f.config.gateway, github: { host: "other.example.test" } },
    });
    await expect(
      f.invoke({ pullRequestUrl: "https://other.example.test/example/repository/pull/7" }),
    ).rejects.toThrow("Link a verified");
  });

  it("rejects arbitrary hosts, credential URLs and non-PR paths before network access", async () => {
    const f = await fixture();
    for (const url of [
      "http://github.com/example/repository/pull/7",
      "https://other.test/example/repository/pull/7",
      "https://name:secret@github.com/example/repository/pull/7",
      "https://github.com/example/repository/issues/7",
      "https://github.com/example/repository/pull/7?token=synthetic",
      "https://github.com/example/repository/pull/0",
    ]) {
      await expect(f.invoke({ pullRequestUrl: url })).rejects.toThrow("pull request URL");
    }
    expect(f.requests).toEqual([]);
  });

  it("keeps admin inspection protected and rejects unrelated fields through both entry points", async () => {
    const f = await fixture();
    for (const raw of [false, true]) {
      for (const extra of [
        { publishingSessionKey: "child" },
        { requestId: randomUUID() },
        { title: "change" },
        { mergeMethod: "merge" },
        { token: "synthetic" },
      ]) {
        await expect(f.invoke(extra, raw)).rejects.toThrow();
      }
      await expect(
        f.invoke({ action: "inspect", pullRequestUrl: undefined }, raw),
      ).rejects.toThrow();
    }
    expect(f.requests).toEqual([]);
  });
});
