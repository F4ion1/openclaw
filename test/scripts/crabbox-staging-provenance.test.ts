import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  files: new Map<string, string>(),
  handles: new Map<number, { bytes: Buffer; offset: number }>(),
  output: new Map<string, string>(),
  namespace: "pid:[4026531836]",
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (path: string, flags: number) => {
      if (!path.startsWith("/proc/") && path !== "/etc/machine-id") {
        return actual.openSync(path, flags);
      }
      const content = native.files.get(path);
      if (content === undefined) {
        throw new Error("fixture OS file missing");
      }
      const fd = 900_000 + native.handles.size;
      native.handles.set(fd, { bytes: Buffer.from(content), offset: 0 });
      return fd;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
      const handle = native.handles.get(fd);
      if (!handle) {
        return actual.readSync(fd, buffer, offset, length, position);
      }
      const count = handle.bytes.copy(buffer, offset, handle.offset, handle.offset + length);
      handle.offset += count;
      return count;
    },
    closeSync: (fd: number) => {
      if (!native.handles.delete(fd)) {
        actual.closeSync(fd);
      }
    },
    readlinkSync: (path: string) =>
      path === "/proc/self/ns/pid" ? native.namespace : actual.readlinkSync(path),
  };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (command: string, args: string[]) => {
    const output = native.output.get(command === "/usr/sbin/ioreg" ? "hardware" : args.at(-1)!);
    return output === undefined
      ? { status: 1, stdout: "", error: new Error("fixture OS command unavailable") }
      : { status: 0, stdout: output };
  },
}));

const bootId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const hostId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const machineId = "abcdef0123456789abcdef0123456789";
const provenance = () => import("../../scripts/crabbox-staging-provenance.mts");
const hardware = (value: string) => native.output.set("hardware", value);

function platform(name: string) {
  const original = process;
  vi.stubGlobal(
    "process",
    new Proxy(original, {
      get(target, key) {
        return key === "platform" ? name : Reflect.get(target, key);
      },
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  native.files.clear();
  native.handles.clear();
  native.output.clear();
  native.namespace = "pid:[4026531836]";
  native.files.set("/etc/machine-id", machineId + "\n");
  native.files.set("/proc/sys/kernel/random/boot_id", bootId + "\n");
  native.files.set("/proc/stat", "cpu 1 2 3 4\nbtime 1700000000\nprocesses 123\n");
  hardware(`"IOPlatformUUID" = "${hostId.toUpperCase()}"`);
  native.output.set("kern.bootsessionuuid", bootId.toUpperCase() + "\n");
  native.output.set(
    "kern.boottime",
    "{ sec = 1700000000, usec = 123456 } Tue Nov 14 22:13:20 2023",
  );
});
afterEach(() => {
  expect(native.handles.size).toBe(0);
  vi.unstubAllGlobals();
});

it.each([
  ["darwin", hostId, "", "bbdb3ca24d48a8202da9e1a2adacd7a86fd060819f45fa8511093995738483eb"],
  [
    "linux",
    machineId,
    "pid:[4026531836]",
    "74017c22ccf4955a2014f6dbbad1d16092cbbc83f0111748a25653c7a0d50568",
  ],
])(
  "captures immutable %s provenance and preserves legacy digest compatibility",
  async (os, host, namespace, digest) => {
    platform(os);
    const { currentProcessProvenance, processDomain } = await provenance();
    const observed = currentProcessProvenance()!;
    const expected = { platform: os, hostId: host, bootId, pidNamespace: namespace };
    expect(observed).toEqual(expected);
    expect(processDomain()).toBe(digest);
    expect(Reflect.set(observed, "hostId", "foreign-host")).toBe(false);
    native.files.clear();
    native.output.clear();
    expect(currentProcessProvenance()).toEqual(expected);
  },
);

it.each([
  ["darwin", "host-missing", () => hardware("no platform identity")],
  ["darwin", "host-invalid", () => hardware('"IOPlatformUUID" = "not-a-uuid"')],
  [
    "darwin",
    "host-nil",
    () => hardware('"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"'),
  ],
  ["darwin", "boot-invalid", () => native.output.set("kern.bootsessionuuid", "not-a-boot-id")],
  ["darwin", "command-failure", () => native.output.delete("kern.bootsessionuuid")],
  ["linux", "host-missing", () => native.files.delete("/etc/machine-id")],
  ["linux", "host-invalid", () => native.files.set("/etc/machine-id", "0".repeat(32))],
  [
    "linux",
    "host-oversized",
    () => native.files.set("/etc/machine-id", machineId + " ".repeat(200)),
  ],
  [
    "linux",
    "boot-invalid",
    () => native.files.set("/proc/sys/kernel/random/boot_id", "not-a-boot-id"),
  ],
  [
    "linux",
    "namespace-invalid",
    () => {
      native.namespace = "pid:[unknown]";
    },
  ],
  ["win32", "unsupported", () => {}],
] as const)("fails closed for %s %s provenance", async (os, _defect, corrupt) => {
  platform(os);
  corrupt();
  const { currentProcessProvenance, processDomain } = await provenance();
  expect(currentProcessProvenance()).toBeUndefined();
  expect(processDomain()).toBeUndefined();
});

it.each([
  { os: "darwin", time: 1700000000123456000n },
  { os: "linux", time: 1700000000000000000n },
])("reads the $os absolute boot time without losing timestamp precision", async ({ os, time }) => {
  platform(os);
  const { currentBootTimeNs } = await provenance();
  expect(currentBootTimeNs()).toBe(time);
});

it.each([
  ["darwin", "{ sec = 1700000000, usec = 1000000 }"],
  ["darwin", "{ sec = -1, usec = 0 }"],
  ["darwin", "unexpected output"],
  ["linux", "cpu 1 2 3 4\n"],
  ["linux", "btime -1\n"],
  ["linux", "btime 1700000000\n" + " ".repeat(1024 * 1024)],
])("refuses unavailable or malformed %s boot times", async (os, output) => {
  platform(os);
  native.output.set("kern.boottime", output);
  native.files.set("/proc/stat", output);
  const { currentBootTimeNs } = await provenance();
  expect(currentBootTimeNs()).toBeUndefined();
});
