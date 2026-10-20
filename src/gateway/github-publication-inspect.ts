import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type {
  SessionGitHubActionParams,
  SessionGitHubPullRequestInspectResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import {
  prepareGitHubPublicationRequesterV2,
  type GitHubPublicationRequesterV2,
} from "./github-publication-requester.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Inspection = SessionGitHubPullRequestInspectResult;
const unavailable = () =>
  new Error(
    "The PR could not be verified as yours with current repository access. Check its URL and your linked GitHub account.",
  );
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

function parsePullRequestUrl(value: string, host: string) {
  const url = URL.parse(value);
  const match = url && /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !repository ||
    !repositoryPattern.test(repository) ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new Error(`Supply a pull request URL on the configured GitHub host (${host}).`);
  }
  return { repository, number };
}

function repositoryFacts(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.full_name !== "string" ||
    !repositoryPattern.test(value.full_name) ||
    typeof value.private !== "boolean" ||
    typeof value.archived !== "boolean" ||
    !isRecord(value.owner) ||
    typeof value.owner.type !== "string"
  ) {
    throw unavailable();
  }
  const permissions = isRecord(value.permissions) ? value.permissions : undefined;
  return {
    id: value.id,
    name: value.full_name,
    private: value.private,
    archived: value.archived,
    ownerType: value.owner.type,
    push: typeof permissions?.push === "boolean" ? permissions.push : undefined,
  };
}

function refFacts(
  value: unknown,
  repository: ReturnType<typeof repositoryFacts>,
): Inspection["base"] {
  if (
    !isRecord(value) ||
    typeof value.ref !== "string" ||
    !value.ref ||
    value.ref.length > 256 ||
    containsAsciiControlCharacter(value.ref) ||
    value.ref.includes(" ") ||
    typeof value.sha !== "string" ||
    !commitPattern.test(value.sha) ||
    !isRecord(value.repo) ||
    value.repo.id !== repository.id ||
    value.repo.full_name !== repository.name
  ) {
    throw unavailable();
  }
  return {
    repository: repository.name,
    repositoryId: repository.id,
    branch: value.ref,
    commit: value.sha,
  };
}

/** Read-only observation. Callers must retain admission and revalidate before using or disclosing it. */
export async function inspectOwnGitHubPullRequest(params: {
  pullRequestUrl: string;
  agentId: string;
  requester: GitHubPublicationRequesterV2;
  assertCurrent: () => void;
}): Promise<{ result: Inspection; assertCurrent: () => void }> {
  params.assertCurrent();
  params.requester.assertCurrent();
  const actor = params.requester.snapshot.actor;
  if (actor.kind !== "operator") {
    throw new Error("Inspecting your PR requires your verified linked GitHub account.");
  }
  const host = resolveConfiguredGitHubHost(currentGitHubPublicationConfig());
  const target = parsePullRequestUrl(params.pullRequestUrl, host);
  const profile = captureResidentUserProfileAccess(actor.profileId);
  const accountIds = () => {
    const facts = profile.readCurrentFacts();
    return host === "github.com"
      ? [...(facts.githubAccountIds ?? [])]
      : facts.emails.flatMap((alias) => {
          const principal = parseEnterpriseGitHubPrincipal(alias);
          return principal?.host === host ? [principal.accountId] : [];
        });
  };
  const admittedIds = accountIds();
  if (!admittedIds.length) {
    throw new Error(
      "Link a verified GitHub account on the configured host before inspecting your PR.",
    );
  }
  const assertRequester = () => {
    params.assertCurrent();
    params.requester.assertCurrent();
    const currentIds = accountIds();
    if (
      resolveConfiguredGitHubHost(currentGitHubPublicationConfig()) !== host ||
      !admittedIds.every((id) => currentIds.includes(id))
    ) {
      throw new Error(
        "Your linked GitHub identity changed; retry inspection with your current account.",
      );
    }
  };
  const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId, assertRequester);
  const assertCurrent = () => {
    assertRequester();
    if (
      (identity.host ?? "github.com") !== host ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    ) {
      throw new Error("The GitHub publisher changed; retry inspection.");
    }
  };
  assertCurrent();
  const read = async (endpoint: string): Promise<unknown> => {
    assertCurrent();
    const response = await runPublicationCommand(githubPublicationApiArgs(endpoint, "GET", host), {
      env: identity.env,
      beforeRun: assertCurrent,
    }).catch(() => {
      assertCurrent();
      throw unavailable();
    });
    assertCurrent();
    if (response.code !== 0) {
      return undefined;
    }
    try {
      return JSON.parse(response.stdout.toString("utf8"));
    } catch {
      throw unavailable();
    }
  };
  const hasAccess = async (repository: string, accountId: number, login: string) => {
    const permission = await read(
      `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return (
      isRecord(permission) &&
      isRecord(permission.user) &&
      permission.user.id === accountId &&
      ["read", "triage", "write", "maintain", "admin"].includes(String(permission.permission))
    );
  };
  const baseRepository = repositoryFacts(await read(`repos/${target.repository}`));
  // Shared reader access alone must never disclose a private PR's existence or author.
  const privateReaders = new Set<number>();
  if (baseRepository.private) {
    for (const accountId of admittedIds) {
      const user = await read(`user/${accountId}`);
      const login =
        isRecord(user) && typeof user.login === "string"
          ? normalizeGitHubLogin(user.login)
          : undefined;
      if (
        isRecord(user) &&
        user.id === accountId &&
        login &&
        (await hasAccess(baseRepository.name, accountId, login))
      ) {
        privateReaders.add(accountId);
      }
    }
    if (!privateReaders.size) {
      throw unavailable();
    }
  }
  const pr = await read(`repos/${baseRepository.name}/pulls/${target.number}`);
  if (
    !isRecord(pr) ||
    !isRecord(pr.user) ||
    typeof pr.user.id !== "number" ||
    !admittedIds.includes(pr.user.id) ||
    (baseRepository.private && !privateReaders.has(pr.user.id)) ||
    typeof pr.user.login !== "string" ||
    !normalizeGitHubLogin(pr.user.login) ||
    pr.number !== target.number ||
    pr.html_url !== `https://${host}/${baseRepository.name}/pull/${target.number}` ||
    (pr.state !== "open" && pr.state !== "closed") ||
    typeof pr.draft !== "boolean" ||
    typeof pr.merged !== "boolean" ||
    typeof pr.maintainer_can_modify !== "boolean" ||
    !isRecord(pr.head)
  ) {
    throw unavailable();
  }
  const base = refFacts(pr.base, baseRepository);
  let headRepository: ReturnType<typeof repositoryFacts> | undefined;
  if (pr.head.repo !== null) {
    const candidate = repositoryFacts(pr.head.repo);
    headRepository =
      candidate.id === baseRepository.id
        ? baseRepository
        : repositoryFacts(await read(`repos/${candidate.name}`));
    if (
      headRepository.id !== candidate.id ||
      headRepository.name !== candidate.name ||
      (headRepository.private &&
        headRepository.id !== baseRepository.id &&
        !(await hasAccess(headRepository.name, pr.user.id, pr.user.login)))
    ) {
      throw unavailable();
    }
  }
  const head = headRepository ? refFacts(pr.head, headRepository) : null;
  let continuation: Inspection["continuation"];
  if (pr.state === "closed" || pr.merged) {
    continuation = {
      status: "blocked",
      reason: "closed",
      message: "This PR is closed or merged; it cannot be continued as an open PR.",
    };
  } else if (!head || !headRepository) {
    continuation = {
      status: "blocked",
      reason: "head_unavailable",
      message: "The original head repository is unavailable. Restore it before continuing this PR.",
    };
  } else if (baseRepository.archived || headRepository.archived) {
    continuation = {
      status: "blocked",
      reason: "repository_archived",
      message: "The base or head repository is archived. It must be writable before continuing.",
    };
  } else {
    const branch = await read(
      `repos/${head.repository}/branches/${encodeURIComponent(head.branch)}`,
    );
    const permission =
      headRepository.push === true
        ? "head_repository_write"
        : pr.maintainer_can_modify &&
            baseRepository.push === true &&
            headRepository.ownerType === "User" &&
            headRepository.id !== baseRepository.id
          ? "maintainer_edits"
          : undefined;
    if (
      !isRecord(branch) ||
      branch.name !== head.branch ||
      !isRecord(branch.commit) ||
      typeof branch.commit.sha !== "string" ||
      !commitPattern.test(branch.commit.sha) ||
      typeof branch.protected !== "boolean"
    ) {
      continuation = {
        status: "unknown",
        reason: "head_unavailable",
        message:
          "The original head branch could not be read. Check its existence and the publisher's access.",
      };
    } else if (branch.commit.sha !== head.commit) {
      continuation = {
        status: "unknown",
        reason: "head_changed",
        message: "The head changed during inspection. Inspect again before preparing work.",
      };
    } else if (!permission) {
      continuation =
        headRepository.push === undefined || baseRepository.push === undefined
          ? {
              status: "unknown",
              reason: "permission_unavailable",
              message:
                "GitHub did not expose enough publisher permission information. Verify access to the original head branch.",
            }
          : {
              status: "blocked",
              reason: "no_head_permission",
              message:
                "The publisher has no observed write permission to the original head. Grant repository access or allow maintainer edits on an eligible fork.",
            };
    } else if (branch.protected) {
      continuation = {
        status: "unknown",
        reason: "protected_branch",
        message:
          "The head branch is protected. Repository permission alone does not establish that the publisher can append commits.",
      };
    } else {
      continuation = {
        status: "permission_observed",
        reason: permission,
        message:
          "GitHub reports permission to contribute to this head. This read does not test commit transport or guarantee a later push; later operations must recheck access and the head.",
      };
    }
  }
  const result: Inspection = {
    url: pr.html_url,
    host,
    number: target.number,
    author: { accountId: pr.user.id, login: pr.user.login },
    state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
    base,
    head,
    publisher: {
      source: identity.source,
      accountId: identity.account.accountId,
      login: identity.account.login,
    },
    maintainerCanModify: pr.maintainer_can_modify,
    continuation,
  };
  assertCurrent();
  return { result, assertCurrent };
}

export async function performSessionGitHubInspection(
  options: Omit<GatewayRequestHandlerOptions, "params"> & {
    params: Extract<SessionGitHubActionParams, { action: "inspect_pr" }>;
  },
): Promise<void> {
  const { params } = options;
  const caller = getGatewayToolCallerIdentity();
  if (
    caller &&
    (params.sessionKey !== caller.sessionKey ||
      (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
  ) {
    throw new Error("GitHub inspection must use the current conversation.");
  }
  using selected = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: caller?.agentId ?? params.agentId,
    assertCurrent: () => options.sessionMutationAuthorization?.assertCurrent(),
  });
  const loaded = selected.readCurrent();
  if (!loaded.entry?.sessionId) {
    throw new Error("The GitHub inspection session is unavailable.");
  }
  const session = { agentId: loaded.agentId, sessionKey: loaded.canonicalKey };
  const admitted = await prepareGitHubPublicationRequesterV2(options, session);
  using _ = { [Symbol.dispose]: admitted.release };
  const inspected = await inspectOwnGitHubPullRequest({
    pullRequestUrl: params.pullRequestUrl,
    agentId: session.agentId,
    requester: admitted.requester,
    assertCurrent: () => {
      selected.readCurrent();
    },
  });
  inspected.assertCurrent();
  options.respond(true, inspected.result);
}
